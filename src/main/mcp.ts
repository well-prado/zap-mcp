/**
 * The MCP server Claude talks to. Streamable HTTP on 127.0.0.1 only, bearer-token protected,
 * stateless (a fresh McpServer per request). Permissions are enforced here, in the app,
 * so a blocked chat never reaches Claude no matter what Claude asks for.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ChatView } from '@shared/types'
import { SERVER_INSTRUCTIONS, TOOLS, type ToolArgs, type ToolName } from '@shared/tools'
import type { Approvals } from './approvals'
import type { Store, StoredMessage } from './db'
import { mimeForPath, type Account, type AccountManager } from './whatsapp'

const APPROVAL_WAIT_MS = 50_000
const MAX_IMAGE_BYTES = 3_500_000
const MAX_FILE_BYTES = 100 * 1024 * 1024

export interface McpContext {
  store: Store
  accounts: AccountManager
  approvals: Approvals
  version: string
}

class ToolError extends Error {}

const text = (t: string): CallToolResult => ({ content: [{ type: 'text', text: t }] })
const json = (v: unknown): CallToolResult => text(JSON.stringify(v, null, 1))

function formatMessage(m: StoredMessage) {
  return {
    id: m.id,
    at: new Date(m.ts).toISOString(),
    from: m.from_me ? 'me' : (m.sender_name ?? m.sender_jid ?? 'unknown'),
    ...(m.text ? { text: m.text } : {}),
    ...(m.media_type ? { media: m.media_type } : {}),
    ...(m.type === 'revoked' ? { deleted: true } : {}),
    ...(m.quoted_id ? { reply_to: m.quoted_id } : {})
  }
}

function parseDate(s: string | undefined, field: string): number | undefined {
  if (!s) return undefined
  const t = Date.parse(s)
  if (Number.isNaN(t)) throw new ToolError(`"${field}" não é uma data válida: ${s}`)
  return t
}

export function buildMcpServer(ctx: McpContext): McpServer {
  const { store, accounts, approvals } = ctx
  const server = new McpServer({ name: 'zap-mcp', version: ctx.version }, { instructions: SERVER_INSTRUCTIONS })

  const pickAccount = (accountId?: string, chatJid?: string): Account => {
    if (accountId) {
      const a = accounts.get(accountId)
      if (!a) throw new ToolError(`Conta "${accountId}" não existe. Use list_accounts.`)
      return a
    }
    const all = accounts.list()
    if (chatJid) {
      const owners = store.accountsWithChat(chatJid)
      if (owners.length === 1) return accounts.get(owners[0])!
      if (owners.length > 1) throw new ToolError(`Esse chat existe em mais de uma conta (${owners.join(', ')}). Informe account_id.`)
    }
    if (all.length === 1) return all[0]
    if (all.length === 0) throw new ToolError('Nenhuma conta do WhatsApp conectada no Zap MCP.')
    throw new ToolError('Há mais de uma conta conectada. Informe account_id (veja list_accounts).')
  }

  /** The chat, only if the user allowed Claude to see it. Blocked chats look exactly like missing ones. */
  const allowedChat = (account: Account, chatJid: string): ChatView => {
    const chat = store.getChat(account.id, chatJid)
    if (!chat || chat.level === 'blocked') {
      throw new ToolError(
        'Chat não encontrado ou não liberado para o Claude. O usuário pode liberá-lo no app Zap MCP (aba Chats).'
      )
    }
    return chat
  }

  const handlers: { [N in ToolName]: (args: ToolArgs<N>) => Promise<CallToolResult> } = {
    list_accounts: async () =>
      json(
        accounts.list().map((a) => {
          const v = a.view()
          return { account_id: v.id, label: v.label, status: v.status, name: v.meName, jid: v.meJid }
        })
      ),

    list_chats: async ({ account_id, query, limit }) => {
      const targets = account_id ? [pickAccount(account_id)] : accounts.list()
      const chats = targets.flatMap((a) =>
        store.listChats({ accountId: a.id, search: query, allowedOnly: true, limit }).map((c) => ({
          account_id: a.id,
          chat_jid: c.jid,
          name: c.name,
          type: c.isGroup ? 'group' : 'direct',
          permission: c.level,
          last_message_at: c.lastMessageAt ? new Date(c.lastMessageAt).toISOString() : undefined
        }))
      )
      chats.sort((x, y) => (y.last_message_at ?? '').localeCompare(x.last_message_at ?? ''))
      store.logActivity({ tool: 'list_chats', summary: `${chats.length} chats listados${query ? ` (filtro "${query}")` : ''}` })
      return json(chats.slice(0, limit))
    },

    read_messages: async ({ chat_jid, account_id, limit, before, after }) => {
      const account = pickAccount(account_id, chat_jid)
      const chat = allowedChat(account, chat_jid)
      const msgs = store.listMessages(account.id, chat.jid, {
        limit,
        before: parseDate(before, 'before'),
        after: parseDate(after, 'after')
      })
      store.logActivity({
        tool: 'read_messages',
        accountId: account.id,
        chatJid: chat.jid,
        summary: `Leu ${msgs.length} mensagens de "${chat.name}"`
      })
      return json({
        account_id: account.id,
        chat: { chat_jid: chat.jid, name: chat.name, type: chat.isGroup ? 'group' : 'direct', permission: chat.level },
        messages: msgs.map(formatMessage)
      })
    },

    search_messages: async ({ query, account_id, chat_jid, limit }) => {
      const account = account_id || chat_jid ? pickAccount(account_id, chat_jid) : undefined
      const chat = chat_jid && account ? allowedChat(account, chat_jid) : undefined
      const results = store.searchMessages({ query, accountId: account?.id, chatJid: chat?.jid, limit })
      store.logActivity({ tool: 'search_messages', summary: `Buscou "${query}" (${results.length} resultados)` })
      return json(
        results.map((m) => ({ account_id: m.account_id, chat_jid: m.chat_jid, chat_name: m.chat_name, ...formatMessage(m) }))
      )
    },

    get_media: async ({ chat_jid, message_id, account_id }) => {
      const account = pickAccount(account_id, chat_jid)
      const chat = allowedChat(account, chat_jid)
      const msg = store.getMessage(account.id, chat.jid, message_id)
      if (!msg?.media_type) throw new ToolError('Mensagem sem mídia (ou id errado).')

      const media = await account.downloadMedia(chat.jid, message_id)
      store.logActivity({
        tool: 'get_media',
        accountId: account.id,
        chatJid: chat.jid,
        summary: `Abriu ${msg.media_type} de "${chat.name}"`
      })

      const content: CallToolResult['content'] = []
      if (media.mimetype.startsWith('image/') && msg.media_type !== 'sticker') {
        const img = await asSendableImage(await readFile(media.path), media.mimetype)
        if (img) content.push({ type: 'image', data: img.data.toString('base64'), mimeType: img.mimeType })
      } else if (media.thumbnail) {
        content.push({ type: 'image', data: media.thumbnail.toString('base64'), mimeType: 'image/jpeg' })
      }
      if (/^(text\/|application\/json)/.test(media.mimetype) && media.size < 200_000) {
        content.push({ type: 'text', text: await readFile(media.path, 'utf8') })
      }
      content.push({
        type: 'text',
        text: JSON.stringify({
          message_id,
          media: msg.media_type,
          mimetype: media.mimetype,
          file_name: media.fileName,
          bytes: media.size,
          seconds: media.seconds,
          saved_to: media.path,
          note:
            msg.media_type === 'video' || msg.media_type === 'video_note'
              ? 'A imagem acima é o quadro de prévia do vídeo; o arquivo completo está em saved_to.'
              : undefined
        })
      })
      return { content }
    },

    send_message: async ({ chat_jid, text: body, account_id, reply_to_message_id }) => {
      const account = pickAccount(account_id, chat_jid)
      const chat = allowedChat(account, chat_jid)
      if (chat.level === 'read') {
        throw new ToolError(`"${chat.name}" está liberado só para leitura. O usuário pode permitir envio no app Zap MCP.`)
      }
      const send = (finalText?: string) => account.sendText(chat.jid, finalText ?? body, reply_to_message_id)

      if (chat.level === 'send') {
        const id = await send()
        store.logActivity({ tool: 'send_message', accountId: account.id, chatJid: chat.jid, summary: `Enviou mensagem para "${chat.name}"` })
        return json({ status: 'sent', message_id: id })
      }

      const r = await approvals.request(
        { accountId: account.id, chatJid: chat.jid, chatName: chat.name, kind: 'text', text: body, replyToId: reply_to_message_id },
        async (finalText) => void (await send(finalText)),
        APPROVAL_WAIT_MS
      )
      store.logActivity({
        tool: 'send_message',
        accountId: account.id,
        chatJid: chat.jid,
        summary: `Pediu para enviar mensagem a "${chat.name}" → ${r.status}`
      })
      return approvalResult(store, r)
    },

    send_file: async ({ chat_jid, file_path, caption, account_id }) => {
      const account = pickAccount(account_id, chat_jid)
      const chat = allowedChat(account, chat_jid)
      if (chat.level === 'read') {
        throw new ToolError(`"${chat.name}" está liberado só para leitura. O usuário pode permitir envio no app Zap MCP.`)
      }
      if (!isAbsolute(file_path)) throw new ToolError('file_path precisa ser um caminho absoluto.')
      const s = await stat(file_path).catch(() => undefined)
      if (!s?.isFile()) throw new ToolError(`Arquivo não encontrado: ${file_path}`)
      if (s.size > MAX_FILE_BYTES) throw new ToolError('Arquivo maior que 100 MB.')

      // Files always go through approval, whatever the chat permission: they can leak local data.
      const r = await approvals.request(
        { accountId: account.id, chatJid: chat.jid, chatName: chat.name, kind: 'file', filePath: file_path, text: caption },
        async (finalCaption) => void (await account.sendFile(chat.jid, file_path, finalCaption ?? caption)),
        APPROVAL_WAIT_MS
      )
      store.logActivity({
        tool: 'send_file',
        accountId: account.id,
        chatJid: chat.jid,
        summary: `Pediu para enviar ${mimeForPath(file_path)} a "${chat.name}" → ${r.status}`
      })
      return approvalResult(store, r)
    }
  }

  for (const name of Object.keys(TOOLS) as ToolName[]) {
    const def = TOOLS[name]
    const handler = handlers[name] as (args: unknown) => Promise<CallToolResult>
    server.registerTool(
      name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema,
        annotations: { readOnlyHint: def.readOnly, destructiveHint: false, openWorldHint: true }
      },
      async (args: unknown): Promise<CallToolResult> => {
        if (store.getSettings().paused) {
          return { isError: true, content: [{ type: 'text', text: 'O acesso do Claude está pausado no app Zap MCP.' }] }
        }
        try {
          return await handler(args)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          if (!(err instanceof ToolError)) store.logActivity({ tool: name, summary: `Erro: ${message}` })
          return { isError: true, content: [{ type: 'text', text: message }] }
        }
      }
    )
  }
  return server
}

function approvalResult(store: Store, r: { id: string; status: string }): CallToolResult {
  const messages: Record<string, string> = {
    sent: 'Aprovado pelo usuário e enviado.',
    rejected: 'O usuário rejeitou o envio. Não tente de novo sem falar com ele.',
    failed: 'Aprovado, mas o envio falhou.',
    pending:
      'Aguardando aprovação no app Zap MCP. Se o usuário aprovar, a mensagem será enviada automaticamente; não reenvie.'
  }
  const error = r.status === 'failed' ? store.listApprovals().find((a) => a.id === r.id)?.error : undefined
  return {
    isError: r.status === 'failed',
    content: [{ type: 'text', text: JSON.stringify({ approval_id: r.id, status: r.status, message: messages[r.status], error }) }]
  }
}

/** Claude accepts images up to a few MB; shrink big photos with sharp when needed. */
async function asSendableImage(data: Buffer, mimeType: string): Promise<{ data: Buffer; mimeType: string } | undefined> {
  const supported = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mimeType)
  if (supported && data.length <= MAX_IMAGE_BYTES) return { data, mimeType }
  try {
    const sharp = (await import('sharp')).default
    const out = await sharp(data).rotate().resize({ width: 1568, height: 1568, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer()
    return { data: out, mimeType: 'image/jpeg' }
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------

export class McpHttpServer {
  private http?: Server
  error?: string

  constructor(private readonly ctx: McpContext) {}

  get running(): boolean {
    return !!this.http?.listening
  }

  async start(port: number, token: string): Promise<void> {
    await this.stop()
    this.error = undefined
    const expected = Buffer.from(`Bearer ${token}`)
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])

    const http = createServer((req, res) => void this.handle(req, res, expected, allowedHosts))
    await new Promise<void>((resolve) => {
      http.once('error', (err: NodeJS.ErrnoException) => {
        this.error = err.code === 'EADDRINUSE' ? `A porta ${port} já está em uso.` : err.message
        resolve()
      })
      http.listen(port, '127.0.0.1', () => {
        this.http = http
        resolve()
      })
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse, expected: Buffer, allowedHosts: Set<string>) {
    const reply = (code: number, body: string) => {
      res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify({ error: body }))
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/mcp') return reply(404, 'not found')
    // Blocks DNS-rebinding: a web page can't pretend to be localhost.
    if (!allowedHosts.has(req.headers.host ?? '')) return reply(403, 'forbidden host')
    const auth = Buffer.from(req.headers.authorization ?? '')
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return reply(401, 'unauthorized')
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      return reply(405, 'method not allowed')
    }

    const server = buildMcpServer(this.ctx)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res)
    } catch (err) {
      if (!res.headersSent) reply(500, err instanceof Error ? err.message : 'internal error')
    }
  }

  async stop(): Promise<void> {
    const http = this.http
    this.http = undefined
    if (http) await new Promise<void>((r) => http.close(() => r()))
  }
}
