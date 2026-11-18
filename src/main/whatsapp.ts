/**
 * WhatsApp accounts. Each account is one Baileys socket = one "linked device" on that phone,
 * the same mechanism WhatsApp Web / Desktop use. No browser involved.
 */
import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import makeWASocket, {
  Browsers,
  BufferJSON,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  getContentType,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  type AnyMessageContent,
  type WAMessage,
  type WASocket,
  type WAVersion
} from 'baileys'

import QRCode from 'qrcode'
import type { AccountStatus, AccountView } from '@shared/types'
import { useSqliteAuthState } from './auth-state'
import type { MessageRow, Store } from './db'

type Logger = NonNullable<Parameters<typeof makeCacheableSignalKeyStore>[1]>

// Message types that are protocol noise, not something a person wrote.
const SKIP_TYPES = new Set([
  'reactionMessage',
  'encReactionMessage',
  'senderKeyDistributionMessage',
  'messageContextInfo',
  'pollUpdateMessage',
  'keepInChatMessage',
  'pinInChatMessage',
  'deviceSentMessage'
])

let cachedVersion: WAVersion | undefined
async function waVersion(logger: Logger): Promise<WAVersion | undefined> {
  if (cachedVersion) return cachedVersion
  try {
    const { version } = await fetchLatestBaileysVersion()
    cachedVersion = version
  } catch (err) {
    logger.warn({ err }, 'could not fetch latest WA web version, using the bundled one')
  }
  return cachedVersion
}

const phoneOf = (jid?: string | null) =>
  jid && jid.endsWith('@s.whatsapp.net') ? `+${jid.split('@')[0].split(':')[0]}` : undefined

const ignoredChat = (jid: string) => isJidBroadcast(jid) || isJidNewsletter(jid) || jid === 'status@broadcast'

const toMs = (ts: WAMessage['messageTimestamp']) => Number(ts ?? 0) * 1000

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'application/pdf': 'pdf'
}
const EXT_MIME: Record<string, string> = Object.fromEntries(Object.entries(MIME_EXT).map(([m, e]) => [e, m]))
Object.assign(EXT_MIME, {
  jpeg: 'image/jpeg',
  m4a: 'audio/mp4',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  txt: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
  json: 'application/json',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip'
})

export function mimeForPath(path: string): string {
  return EXT_MIME[extname(path).slice(1).toLowerCase()] ?? 'application/octet-stream'
}

export interface DownloadedMedia {
  path: string
  mimetype: string
  fileName?: string
  size: number
  /** JPEG preview frame embedded in the message (videos, documents, stickers). */
  thumbnail?: Buffer
  seconds?: number
}

export class Account extends EventEmitter {
  status: AccountStatus = 'disconnected'
  qr?: string
  lastError?: string
  private sock?: WASocket
  private stopped = false
  private retries = 0
  private retryTimer?: NodeJS.Timeout

  constructor(
    readonly id: string,
    private readonly store: Store,
    private readonly mediaDir: string,
    private readonly logger: Logger,
    private readonly opts: { syncFullHistory: () => boolean; newChatLevel: () => 'blocked' | 'read' | 'draft' }
  ) {
    super()
  }

  get label(): string {
    return this.store.listAccounts().find((a) => a.id === this.id)?.label ?? this.id
  }

  view(): AccountView {
    const row = this.store.listAccounts().find((a) => a.id === this.id)
    return {
      id: this.id,
      label: row?.label ?? this.id,
      status: this.status,
      meJid: row?.me_jid ?? undefined,
      meName: row?.me_name ?? undefined,
      qr: this.status === 'qr' ? this.qr : undefined,
      lastError: this.lastError
    }
  }

  get connected(): boolean {
    return this.status === 'connected' && !!this.sock
  }

  private setStatus(status: AccountStatus, error?: string): void {
    this.status = status
    this.lastError = error
    if (status !== 'qr') this.qr = undefined
    this.emit('changed')
  }

  async start(): Promise<void> {
    this.stopped = false
    clearTimeout(this.retryTimer)
    if (this.sock) return
    this.setStatus('starting')

    const { state, saveCreds } = useSqliteAuthState(this.store, this.id)
    const version = await waVersion(this.logger)
    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, this.logger) },
      logger: this.logger,
      // Don't use Browsers.macOS('Desktop'): as of Nov 2026 WhatsApp terminates that handshake (428)
      // before handing out a QR. Full history is requested by syncFullHistory, not by the browser name.
      browser: Browsers.macOS('Chrome'),
      syncFullHistory: this.opts.syncFullHistory(),
      // Staying "offline" keeps notifications on your phone working as usual.
      markOnlineOnConnect: false,
      getMessage: async (key) => {
        const raw = key.id ? this.store.getRawMessageById(this.id, key.id) : undefined
        return raw ? (JSON.parse(raw, BufferJSON.reviver) as WAMessage).message ?? undefined : undefined
      }
    })
    this.sock = sock

    sock.ev.on('creds.update', saveCreds)

    let qrShown = false
    sock.ev.on('connection.update', async (u) => {
      if (u.qr) {
        qrShown = true
        this.qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 300 })
        this.setStatus('qr')
      } else if (u.connection === 'connecting' && this.status !== 'qr') {
        this.setStatus('connecting')
      }

      if (u.connection === 'open') {
        this.retries = 0
        const me = sock.user
        if (me?.id) this.store.setAccountMe(this.id, jidNormalizedUser(me.id), me.name ?? me.notify ?? undefined)
        this.setStatus('connected')
        void this.syncGroups()
        void this.resolveLidNames()
      }

      if (u.connection === 'close') {
        if (this.sock === sock) this.sock = undefined
        if (this.stopped) return this.setStatus('disconnected')
        const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode
        const paired = !!state.creds.me

        if (code === DisconnectReason.loggedOut) {
          this.store.clearAuth(this.id)
          return this.setStatus('logged_out', 'Este Mac foi desconectado pelo celular. Conecte de novo com o QR code.')
        }
        if (code === DisconnectReason.connectionReplaced) {
          return this.setStatus('disconnected', 'Outra sessão do Zap MCP assumiu esta conta.')
        }
        if (!paired && code !== DisconnectReason.restartRequired) {
          return this.setStatus(
            'disconnected',
            qrShown
              ? 'O QR code expirou. Clique em Conectar para gerar outro.'
              : `O WhatsApp recusou a conexão antes de gerar o QR (código ${code ?? '?'}). Veja logs/whatsapp.log.`
          )
        }
        // 515 right after scanning the QR is expected: WhatsApp asks for a fresh connection.
        const delay = code === DisconnectReason.restartRequired ? 0 : Math.min(60_000, 2_000 * 2 ** this.retries++)
        this.setStatus('connecting', delay ? `Conexão caiu (código ${code ?? '?'}), tentando de novo…` : undefined)
        this.retryTimer = setTimeout(() => void this.start(), delay)
      }
    })

    sock.ev.on('messaging-history.set', ({ chats, contacts, messages, lidPnMappings }) => {
      for (const m of lidPnMappings ?? []) this.learnLidPn(m.lid, m.pn)
      for (const c of contacts) this.ingestContact(c)
      for (const c of chats) {
        if (!c.id || ignoredChat(c.id)) continue
        this.store.ensureChat(this.id, c.id, {
          name: c.name ?? undefined,
          isGroup: !!isJidGroup(c.id),
          level: this.opts.newChatLevel()
        })
      }
      this.ingestMessages(messages)
    })

    sock.ev.on('messages.upsert', ({ messages }) => this.ingestMessages(messages))

    sock.ev.on('chats.upsert', (chats) => {
      for (const c of chats) {
        if (!c.id || ignoredChat(c.id)) continue
        this.store.ensureChat(this.id, c.id, {
          name: c.name ?? undefined,
          isGroup: !!isJidGroup(c.id),
          level: this.opts.newChatLevel()
        })
      }
      this.emit('data')
    })

    sock.ev.on('chats.update', (updates) => {
      for (const c of updates) {
        if (c.id && c.name && !ignoredChat(c.id)) {
          this.store.ensureChat(this.id, c.id, { name: c.name, isGroup: !!isJidGroup(c.id), level: this.opts.newChatLevel() })
        }
      }
    })

    sock.ev.on('contacts.upsert', (cs) => cs.forEach((c) => this.ingestContact(c)))
    sock.ev.on('contacts.update', (cs) => cs.forEach((c) => c.id && this.ingestContact(c as { id: string })))

    sock.ev.on('groups.upsert', (gs) => {
      for (const g of gs) this.store.ensureChat(this.id, g.id, { name: g.subject, isGroup: true, level: this.opts.newChatLevel() })
      this.emit('data')
    })
    sock.ev.on('groups.update', (gs) => {
      for (const g of gs) {
        if (g.id && g.subject) {
          this.store.ensureChat(this.id, g.id, { name: g.subject, isGroup: true, level: this.opts.newChatLevel() })
        }
      }
    })

    sock.ev.on('lid-mapping.update', ({ lid, pn }) => this.learnLidPn(lid, pn))
  }

  /**
   * WhatsApp identifies many people by an opaque LID instead of their number. When we learn
   * which phone number a LID belongs to, treat both as one chat and keep the number as a name fallback.
   */
  private learnLidPn(lid?: string, pn?: string): void {
    if (!lid || !pn) return
    const [l, p] = [jidNormalizedUser(lid), jidNormalizedUser(pn)]
    const phone = phoneOf(p)
    this.store.linkJids(this.id, p, l)
    this.store.upsertContact(this.id, { jid: l, phone })
    this.store.upsertContact(this.id, { jid: p, phone })
  }

  /** Ask Baileys' local LID store for the numbers behind chats that still show only a LID. */
  private async resolveLidNames(): Promise<void> {
    const lids = this.store.lidChatsWithoutName(this.id)
    if (!lids.length || !this.sock) return
    try {
      const found = (await this.sock.signalRepository.lidMapping.getPNsForLIDs(lids)) ?? []
      for (const m of found) this.learnLidPn(m.lid, m.pn)
      if (found.length) this.emit('data')
      this.logger.info({ asked: lids.length, resolved: found.length }, 'resolved LID chat names')
    } catch (err) {
      this.logger.warn({ err }, 'LID → phone lookup failed')
    }
  }

  private async syncGroups(): Promise<void> {
    try {
      const groups = await this.sock?.groupFetchAllParticipating()
      for (const g of Object.values(groups ?? {})) {
        this.store.ensureChat(this.id, g.id, { name: g.subject, isGroup: true, level: this.opts.newChatLevel() })
      }
      this.emit('data')
    } catch (err) {
      this.logger.warn({ err }, 'groupFetchAllParticipating failed')
    }
  }

  private ingestContact(c: { id: string; lid?: string; phoneNumber?: string; name?: string; notify?: string }): void {
    const phone = phoneOf(c.phoneNumber) ?? phoneOf(c.id)
    for (const jid of new Set([c.id, c.lid, c.phoneNumber].filter(Boolean) as string[])) {
      this.store.upsertContact(this.id, { jid, name: c.name, notify: c.notify, phone })
    }
    if (c.lid && c.phoneNumber) this.store.linkJids(this.id, c.phoneNumber, c.lid)
  }

  /** Turn Baileys messages into rows; applies edits and deletions in place. */
  ingestMessages(messages: WAMessage[]): void {
    const rows: MessageRow[] = []
    for (const m of messages) {
      const key = m.key
      if (!key?.remoteJid || !key.id || ignoredChat(key.remoteJid)) continue

      const raw = m.message
      const proto = raw?.protocolMessage
      if (proto) {
        const target = proto.key?.id
        const edited = proto.editedMessage ? normalizeMessageContent(proto.editedMessage) : undefined
        const editedText = edited?.conversation ?? edited?.extendedTextMessage?.text ?? edited?.imageMessage?.caption
        if (target && editedText) this.store.editMessage(this.id, target, editedText)
        else if (target && proto.type === 0 /* REVOKE */) this.store.revokeMessage(this.id, target)
        continue
      }

      const content = normalizeMessageContent(raw)
      const type = getContentType(content)
      if (!content || !type || SKIP_TYPES.has(type)) continue

      let text: string | undefined | null
      let mediaType: string | undefined
      let quotedId: string | undefined | null
      switch (type) {
        case 'conversation':
          text = content.conversation
          break
        case 'extendedTextMessage':
          text = content.extendedTextMessage?.text
          quotedId = content.extendedTextMessage?.contextInfo?.stanzaId
          break
        case 'imageMessage':
          mediaType = 'image'
          text = content.imageMessage?.caption
          quotedId = content.imageMessage?.contextInfo?.stanzaId
          break
        case 'videoMessage':
          mediaType = content.videoMessage?.gifPlayback ? 'gif' : 'video'
          text = content.videoMessage?.caption
          quotedId = content.videoMessage?.contextInfo?.stanzaId
          break
        case 'ptvMessage':
          mediaType = 'video_note'
          break
        case 'audioMessage':
          mediaType = content.audioMessage?.ptt ? 'voice' : 'audio'
          quotedId = content.audioMessage?.contextInfo?.stanzaId
          break
        case 'documentMessage': {
          mediaType = 'document'
          const d = content.documentMessage
          text = [d?.fileName, d?.caption].filter(Boolean).join(' — ') || undefined
          quotedId = d?.contextInfo?.stanzaId
          break
        }
        case 'stickerMessage':
          mediaType = 'sticker'
          break
        case 'locationMessage': {
          const l = content.locationMessage
          text = `📍 ${[l?.name, l?.address].filter(Boolean).join(', ')} (${l?.degreesLatitude}, ${l?.degreesLongitude})`
          break
        }
        case 'contactMessage':
          text = `👤 Contato: ${content.contactMessage?.displayName ?? ''}`
          break
        case 'pollCreationMessage':
        case 'pollCreationMessageV2':
        case 'pollCreationMessageV3': {
          const p = content[type]
          text = `📊 Enquete: ${p?.name ?? ''} — ${(p?.options ?? []).map((o) => o.optionName).join(' / ')}`
          break
        }
        default:
          continue
      }

      const isGroup = !!isJidGroup(key.remoteJid)
      let chatJid = key.remoteJid
      if (key.remoteJidAlt) chatJid = this.store.linkJids(this.id, key.remoteJid, key.remoteJidAlt)
      chatJid = this.store.ensureChat(this.id, chatJid, { isGroup, level: this.opts.newChatLevel() })

      const senderJid = key.fromMe ? undefined : isGroup ? (key.participantAlt ?? key.participant ?? undefined) : key.remoteJid
      if (senderJid && m.pushName) this.store.upsertContact(this.id, { jid: senderJid, notify: m.pushName, phone: phoneOf(senderJid) })
      const senderName = key.fromMe
        ? 'Eu'
        : (m.pushName ??
          (senderJid ? this.store.contactName(this.id, senderJid) : undefined) ??
          phoneOf(senderJid) ??
          senderJid)

      rows.push({
        accountId: this.id,
        chatJid,
        id: key.id,
        fromMe: !!key.fromMe,
        senderJid,
        senderName: senderName ?? undefined,
        ts: toMs(m.messageTimestamp),
        type,
        text: text ?? undefined,
        mediaType,
        quotedId: quotedId ?? undefined,
        raw: JSON.stringify(m, BufferJSON.replacer)
      })
    }
    this.store.upsertMessages(rows)
    if (rows.length) this.emit('data')
  }

  private requireSocket(): WASocket {
    if (!this.sock || this.status !== 'connected') {
      throw new Error(`A conta "${this.label}" não está conectada agora.`)
    }
    return this.sock
  }

  async sendText(chatJid: string, text: string, replyToId?: string): Promise<string | undefined> {
    const sock = this.requireSocket()
    const quotedRaw = replyToId ? this.store.getRawMessage(this.id, chatJid, replyToId) : undefined
    const quoted = quotedRaw ? (JSON.parse(quotedRaw, BufferJSON.reviver) as WAMessage) : undefined
    const sent = await sock.sendMessage(chatJid, { text }, quoted ? { quoted } : undefined)
    if (sent) this.ingestMessages([sent])
    return sent?.key.id ?? undefined
  }

  async sendFile(chatJid: string, path: string, caption?: string): Promise<string | undefined> {
    const sock = this.requireSocket()
    const data = await readFile(path)
    const mimetype = mimeForPath(path)
    let content: AnyMessageContent
    if (/^image\/(jpeg|png|webp)$/.test(mimetype)) content = { image: data, caption, mimetype }
    else if (mimetype === 'video/mp4') content = { video: data, caption, mimetype }
    else if (mimetype.startsWith('audio/')) content = { audio: data, mimetype }
    else content = { document: data, mimetype, fileName: basename(path), caption }
    const sent = await sock.sendMessage(chatJid, content)
    if (sent) this.ingestMessages([sent])
    return sent?.key.id ?? undefined
  }

  async downloadMedia(chatJid: string, messageId: string): Promise<DownloadedMedia> {
    const raw = this.store.getRawMessage(this.id, chatJid, messageId)
    if (!raw) throw new Error('Mensagem não encontrada.')
    const msg = JSON.parse(raw, BufferJSON.reviver) as WAMessage
    const content = normalizeMessageContent(msg.message)
    const type = getContentType(content)
    const media = (type && content ? content[type] : undefined) as
      | { mimetype?: string | null; fileName?: string | null; jpegThumbnail?: Uint8Array | null; seconds?: number | null }
      | undefined
    if (!media || typeof media !== 'object' || !('mimetype' in media)) throw new Error('Esta mensagem não tem mídia.')

    const mimetype = (media.mimetype ?? 'application/octet-stream').split(';')[0].trim()
    const thumbnail = media.jpegThumbnail?.length ? Buffer.from(media.jpegThumbnail) : undefined
    const stored = this.store.getMessage(this.id, chatJid, messageId)
    if (stored?.media_path) {
      const s = await stat(stored.media_path).catch(() => undefined)
      if (s) return { path: stored.media_path, mimetype, fileName: media.fileName ?? undefined, size: s.size, thumbnail, seconds: media.seconds ?? undefined }
    }

    const sock = this.sock
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
      logger: this.logger,
      // Old media expires on WhatsApp's CDN; the phone can re-upload it while we are connected.
      reuploadRequest: sock
        ? sock.updateMediaMessage
        : async () => {
            throw new Error('Mídia expirada e a conta está desconectada; conecte para baixar de novo.')
          }
    })
    const ext = MIME_EXT[mimetype] || (media.fileName ? extname(media.fileName).slice(1) : '') || 'bin'
    const dir = join(this.mediaDir, this.id, chatJid.replace(/[^\w.-]/g, '_'))
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${messageId.replace(/[^\w.-]/g, '_')}${ext ? `.${ext}` : ''}`)
    await writeFile(path, buffer)
    this.store.setMediaPath(this.id, chatJid, messageId, path)
    return { path, mimetype, fileName: media.fileName ?? undefined, size: buffer.length, thumbnail, seconds: media.seconds ?? undefined }
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.retryTimer)
    const sock = this.sock
    this.sock = undefined
    sock?.end(undefined)
    this.setStatus('disconnected')
  }

  /** Unlink this Mac from the phone and forget the session. */
  async logout(): Promise<void> {
    this.stopped = true
    clearTimeout(this.retryTimer)
    try {
      await this.sock?.logout()
    } catch {
      // already gone
    }
    this.sock = undefined
    this.store.clearAuth(this.id)
  }
}

export class AccountManager extends EventEmitter {
  private accounts = new Map<string, Account>()

  constructor(
    private readonly store: Store,
    private readonly mediaDir: string,
    private readonly logger: Logger
  ) {
    super()
    for (const row of store.listAccounts()) this.attach(row.id)
  }

  private attach(id: string): Account {
    const settings = () => this.store.getSettings()
    const account = new Account(id, this.store, this.mediaDir, this.logger, {
      syncFullHistory: () => settings().syncFullHistory,
      newChatLevel: () => settings().newChatPolicy
    })
    account.on('changed', () => this.emit('changed'))
    account.on('data', () => this.emit('data'))
    this.accounts.set(id, account)
    return account
  }

  /** Start every account that has already been paired. */
  async startAll(): Promise<void> {
    for (const a of this.accounts.values()) {
      if (this.store.hasCreds(a.id)) await a.start()
    }
  }

  async add(label: string): Promise<Account> {
    const id = randomBytes(4).toString('hex')
    this.store.createAccount(id, label.trim() || `Conta ${this.accounts.size + 1}`)
    const account = this.attach(id)
    await account.start()
    this.emit('changed')
    return account
  }

  async remove(id: string): Promise<void> {
    const account = this.accounts.get(id)
    if (!account) return
    await account.logout()
    this.accounts.delete(id)
    this.store.deleteAccount(id)
    this.emit('changed')
  }

  get(id: string): Account | undefined {
    return this.accounts.get(id)
  }

  list(): Account[] {
    return [...this.accounts.values()]
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.list().map((a) => a.stop()))
  }
}
