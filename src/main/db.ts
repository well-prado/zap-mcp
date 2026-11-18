/**
 * Local storage on Node's built-in SQLite (no native module to rebuild for Electron).
 * One database holds every account; rows are keyed by account_id.
 */
import { DatabaseSync } from 'node:sqlite'
import type {
  ActivityView,
  AppSettings,
  ApprovalStatus,
  ApprovalView,
  ChatQuery,
  ChatView,
  PermissionLevel
} from '@shared/types'
import { PERMISSION_LEVELS } from '@shared/types'
import { DEFAULT_MCP_PORT } from '@shared/tools'

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  me_jid TEXT,
  me_name TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_creds (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  creds TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_keys (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  id TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (account_id, type, id)
);

CREATE TABLE IF NOT EXISTS chats (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  jid TEXT NOT NULL,
  name TEXT,
  is_group INTEGER NOT NULL DEFAULT 0,
  level TEXT NOT NULL,
  last_message_at INTEGER,
  PRIMARY KEY (account_id, jid)
);

-- The same 1:1 chat can show up as a phone-number jid and as a LID jid.
CREATE TABLE IF NOT EXISTS jid_alias (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  jid TEXT NOT NULL,
  PRIMARY KEY (account_id, alias)
);

CREATE TABLE IF NOT EXISTS contacts (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  jid TEXT NOT NULL,
  name TEXT,
  notify TEXT,
  phone TEXT,
  PRIMARY KEY (account_id, jid)
);

CREATE TABLE IF NOT EXISTS messages (
  rowid INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  chat_jid TEXT NOT NULL,
  id TEXT NOT NULL,
  from_me INTEGER NOT NULL,
  sender_jid TEXT,
  sender_name TEXT,
  ts INTEGER NOT NULL,
  type TEXT,
  text TEXT,
  media_type TEXT,
  media_path TEXT,
  quoted_id TEXT,
  raw TEXT,
  UNIQUE (account_id, chat_jid, id)
);
CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages (account_id, chat_jid, ts);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text, content = 'messages', content_rowid = 'rowid', tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF text ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO messages_fts (rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  chat_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT,
  file_path TEXT,
  reply_to_id TEXT,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  error TEXT
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  tool TEXT NOT NULL,
  account_id TEXT,
  chat_jid TEXT,
  summary TEXT NOT NULL
);
`

const DEFAULT_SETTINGS: AppSettings = {
  newChatPolicy: 'blocked',
  paused: false,
  syncFullHistory: true,
  openAtLogin: false,
  mcpPort: DEFAULT_MCP_PORT
}

export interface MessageRow {
  accountId: string
  chatJid: string
  id: string
  fromMe: boolean
  senderJid?: string
  senderName?: string
  ts: number
  type?: string
  text?: string
  mediaType?: string
  quotedId?: string
  raw: string
}

export interface StoredMessage {
  account_id: string
  chat_jid: string
  chat_name?: string
  id: string
  from_me: number
  sender_jid: string | null
  sender_name: string | null
  ts: number
  type: string | null
  text: string | null
  media_type: string | null
  media_path: string | null
  quoted_id: string | null
}

type Row = Record<string, unknown>

export class Store {
  readonly db: DatabaseSync

  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec(SCHEMA)
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  // ---------- settings ----------

  getSettings(): AppSettings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
    const out: Record<string, unknown> = { ...DEFAULT_SETTINGS }
    for (const r of rows) out[r.key] = JSON.parse(r.value)
    return out as unknown as AppSettings
  }

  setSettings(patch: Partial<AppSettings>): AppSettings {
    const stmt = this.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) stmt.run(k, JSON.stringify(v))
    return this.getSettings()
  }

  getSecret(key: string): string | undefined {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(`secret:${key}`) as Row | undefined
    return r ? JSON.parse(r.value as string) : undefined
  }

  setSecret(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(`secret:${key}`, JSON.stringify(value))
  }

  // ---------- accounts ----------

  listAccounts(): { id: string; label: string; me_jid: string | null; me_name: string | null }[] {
    return this.db.prepare('SELECT id, label, me_jid, me_name FROM accounts ORDER BY created_at').all() as never
  }

  createAccount(id: string, label: string): void {
    this.db.prepare('INSERT INTO accounts (id, label, created_at) VALUES (?, ?, ?)').run(id, label, Date.now())
  }

  setAccountMe(id: string, meJid: string, meName?: string): void {
    this.db.prepare('UPDATE accounts SET me_jid = ?, me_name = ? WHERE id = ?').run(meJid, meName ?? null, id)
  }

  deleteAccount(id: string): void {
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
  }

  hasCreds(accountId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM auth_creds WHERE account_id = ?').get(accountId)
  }

  // ---------- Baileys auth state ----------

  readCreds(accountId: string): string | undefined {
    const r = this.db.prepare('SELECT creds FROM auth_creds WHERE account_id = ?').get(accountId) as Row | undefined
    return r?.creds as string | undefined
  }

  writeCreds(accountId: string, json: string): void {
    this.db
      .prepare(
        'INSERT INTO auth_creds (account_id, creds) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET creds = excluded.creds'
      )
      .run(accountId, json)
  }

  readKeys(accountId: string, type: string, ids: string[]): Map<string, string> {
    const out = new Map<string, string>()
    const stmt = this.db.prepare('SELECT value FROM auth_keys WHERE account_id = ? AND type = ? AND id = ?')
    for (const id of ids) {
      const r = stmt.get(accountId, type, id) as Row | undefined
      if (r) out.set(id, r.value as string)
    }
    return out
  }

  writeKeys(accountId: string, entries: { type: string; id: string; value: string | null }[]): void {
    const put = this.db.prepare(
      'INSERT INTO auth_keys (account_id, type, id, value) VALUES (?, ?, ?, ?) ON CONFLICT(account_id, type, id) DO UPDATE SET value = excluded.value'
    )
    const del = this.db.prepare('DELETE FROM auth_keys WHERE account_id = ? AND type = ? AND id = ?')
    this.tx(() => {
      for (const e of entries) {
        if (e.value === null) del.run(accountId, e.type, e.id)
        else put.run(accountId, e.type, e.id, e.value)
      }
    })
  }

  clearAuth(accountId: string): void {
    this.tx(() => {
      this.db.prepare('DELETE FROM auth_creds WHERE account_id = ?').run(accountId)
      this.db.prepare('DELETE FROM auth_keys WHERE account_id = ?').run(accountId)
    })
  }

  // ---------- chats ----------

  /** Canonical jid for a chat, following phone-number <-> LID aliases. */
  resolveJid(accountId: string, jid: string): string {
    const r = this.db.prepare('SELECT jid FROM jid_alias WHERE account_id = ? AND alias = ?').get(accountId, jid) as
      | Row
      | undefined
    return (r?.jid as string) ?? jid
  }

  /**
   * Record that `a` and `b` are the same chat. If one of them is already a known chat,
   * the other becomes its alias; otherwise `a` wins.
   */
  linkJids(accountId: string, a: string, b: string): string {
    const ca = this.resolveJid(accountId, a)
    const cb = this.resolveJid(accountId, b)
    if (ca === cb) return ca
    const known = (j: string) => !!this.db.prepare('SELECT 1 FROM chats WHERE account_id = ? AND jid = ?').get(accountId, j)
    const [canonical, alias] = known(cb) && !known(ca) ? [cb, ca] : [ca, cb]
    this.tx(() => {
      if (known(alias)) {
        // Both forms were stored before we learned they are one chat: fold the alias into the canonical one,
        // keeping the MORE restrictive of the two permission levels so merging never widens access.
        const rank = (j: string) => {
          const r = this.db.prepare('SELECT level FROM chats WHERE account_id = ? AND jid = ?').get(accountId, j) as Row
          return PERMISSION_LEVELS.indexOf(r.level as PermissionLevel)
        }
        const level = PERMISSION_LEVELS[Math.min(rank(canonical), rank(alias))]
        this.db.prepare('UPDATE chats SET level = ? WHERE account_id = ? AND jid = ?').run(level, accountId, canonical)
        this.db
          .prepare('UPDATE OR IGNORE messages SET chat_jid = ? WHERE account_id = ? AND chat_jid = ?')
          .run(canonical, accountId, alias)
        this.db.prepare('DELETE FROM messages WHERE account_id = ? AND chat_jid = ?').run(accountId, alias)
        this.db.prepare('DELETE FROM chats WHERE account_id = ? AND jid = ?').run(accountId, alias)
      }
      this.db
        .prepare(
          'INSERT INTO jid_alias (account_id, alias, jid) VALUES (?, ?, ?) ON CONFLICT(account_id, alias) DO UPDATE SET jid = excluded.jid'
        )
        .run(accountId, alias, canonical)
      this.db.prepare('UPDATE jid_alias SET jid = ? WHERE account_id = ? AND jid = ?').run(canonical, accountId, alias)
    })
    return canonical
  }

  /** Insert the chat if unseen (with the new-chat policy as its level). Returns the canonical jid. */
  ensureChat(accountId: string, jid: string, opts: { name?: string | null; isGroup?: boolean; level: PermissionLevel }): string {
    const canonical = this.resolveJid(accountId, jid)
    this.db
      .prepare(
        `INSERT INTO chats (account_id, jid, name, is_group, level) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(account_id, jid) DO UPDATE SET name = COALESCE(excluded.name, chats.name)`
      )
      .run(accountId, canonical, opts.name || null, opts.isGroup ? 1 : 0, opts.level)
    return canonical
  }

  touchChat(accountId: string, jid: string, ts: number): void {
    this.db
      .prepare(
        'UPDATE chats SET last_message_at = MAX(COALESCE(last_message_at, 0), ?) WHERE account_id = ? AND jid = ?'
      )
      .run(ts, accountId, jid)
  }

  getChat(accountId: string, jid: string): ChatView | undefined {
    const canonical = this.resolveJid(accountId, jid)
    const r = this.db.prepare(`${CHAT_SELECT} WHERE c.account_id = ? AND c.jid = ?`).get(accountId, canonical) as
      | Row
      | undefined
    return r ? toChatView(r) : undefined
  }

  /** Which accounts know this chat (used when the caller omits account_id). */
  accountsWithChat(jid: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT account_id FROM chats WHERE jid = ?
         UNION SELECT DISTINCT account_id FROM jid_alias WHERE alias = ?`
      )
      .all(jid, jid) as Row[]
    return rows.map((r) => r.account_id as string)
  }

  listChats(q: ChatQuery & { allowedOnly?: boolean; limit?: number }): ChatView[] {
    const where = ['c.account_id = ?']
    const args: (string | number)[] = [q.accountId]
    if (q.allowedOnly) where.push(`c.level != 'blocked'`)
    if (q.filter === 'groups') where.push('c.is_group = 1')
    if (q.filter === 'direct') where.push('c.is_group = 0')
    if (q.filter === 'enabled') where.push(`c.level != 'blocked'`)
    if (q.search) {
      where.push(`(${DISPLAY_NAME} LIKE ? ESCAPE '\\')`)
      args.push(`%${q.search.replace(/[%_\\]/g, (m) => `\\${m}`)}%`)
    }
    args.push(q.limit ?? 5000)
    const rows = this.db
      .prepare(
        `${CHAT_SELECT} WHERE ${where.join(' AND ')}
         ORDER BY c.last_message_at IS NULL, c.last_message_at DESC, display_name LIMIT ?`
      )
      .all(...args) as Row[]
    return rows.map(toChatView)
  }

  /** 1:1 chats known only by LID, with nothing to show as a name: candidates for a LID → phone lookup. */
  lidChatsWithoutName(accountId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT c.jid FROM chats c LEFT JOIN contacts ct ON ct.account_id = c.account_id AND ct.jid = c.jid
         WHERE c.account_id = ? AND c.jid LIKE '%@lid' AND ${DISPLAY_NAME} = c.jid`
      )
      .all(accountId) as Row[]
    return rows.map((r) => r.jid as string)
  }

  setChatLevel(accountId: string, jids: string[], level: PermissionLevel): void {
    const stmt = this.db.prepare('UPDATE chats SET level = ? WHERE account_id = ? AND jid = ?')
    this.tx(() => {
      for (const jid of jids) stmt.run(level, accountId, this.resolveJid(accountId, jid))
    })
  }

  // ---------- contacts ----------

  upsertContact(accountId: string, c: { jid: string; name?: string | null; notify?: string | null; phone?: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO contacts (account_id, jid, name, notify, phone) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(account_id, jid) DO UPDATE SET
           name = COALESCE(excluded.name, contacts.name),
           notify = COALESCE(excluded.notify, contacts.notify),
           phone = COALESCE(excluded.phone, contacts.phone)`
      )
      .run(accountId, c.jid, c.name ?? null, c.notify ?? null, c.phone ?? null)
  }

  contactName(accountId: string, jid: string): string | undefined {
    const r = this.db
      .prepare('SELECT COALESCE(name, notify, phone) AS n FROM contacts WHERE account_id = ? AND jid = ?')
      .get(accountId, jid) as Row | undefined
    return (r?.n as string) ?? undefined
  }

  // ---------- messages ----------

  upsertMessages(rows: MessageRow[]): void {
    if (!rows.length) return
    const stmt = this.db.prepare(
      `INSERT INTO messages (account_id, chat_jid, id, from_me, sender_jid, sender_name, ts, type, text, media_type, quoted_id, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, chat_jid, id) DO UPDATE SET
         text = COALESCE(excluded.text, messages.text),
         sender_name = COALESCE(excluded.sender_name, messages.sender_name),
         raw = excluded.raw`
    )
    this.tx(() => {
      for (const m of rows) {
        stmt.run(
          m.accountId,
          m.chatJid,
          m.id,
          m.fromMe ? 1 : 0,
          m.senderJid ?? null,
          m.senderName ?? null,
          m.ts,
          m.type ?? null,
          m.text ?? null,
          m.mediaType ?? null,
          m.quotedId ?? null,
          m.raw
        )
        this.touchChat(m.accountId, m.chatJid, m.ts)
      }
    })
  }

  listMessages(accountId: string, chatJid: string, opts: { limit: number; before?: number; after?: number }): StoredMessage[] {
    const rows = this.db
      .prepare(
        `SELECT account_id, chat_jid, id, from_me, sender_jid, sender_name, ts, type, text, media_type, media_path, quoted_id
         FROM messages WHERE account_id = ? AND chat_jid = ? AND ts < ? AND ts > ?
         ORDER BY ts DESC LIMIT ?`
      )
      .all(accountId, chatJid, opts.before ?? Number.MAX_SAFE_INTEGER, opts.after ?? 0, opts.limit) as unknown as StoredMessage[]
    return rows.reverse()
  }

  /** Full-text search restricted to chats that are not blocked. */
  searchMessages(opts: { query: string; accountId?: string; chatJid?: string; limit: number }): StoredMessage[] {
    const run = (match: string) =>
      this.db
        .prepare(
          `SELECT m.account_id, m.chat_jid, m.id, m.from_me, m.sender_jid, m.sender_name, m.ts, m.type, m.text,
                  m.media_type, m.media_path, m.quoted_id,
                  ${DISPLAY_NAME} AS chat_name
           FROM messages_fts f
           JOIN messages m ON m.rowid = f.rowid
           JOIN chats c ON c.account_id = m.account_id AND c.jid = m.chat_jid
           LEFT JOIN contacts ct ON ct.account_id = c.account_id AND ct.jid = c.jid
           WHERE messages_fts MATCH ? AND c.level != 'blocked'
             AND (? IS NULL OR m.account_id = ?) AND (? IS NULL OR m.chat_jid = ?)
           ORDER BY m.ts DESC LIMIT ?`
        )
        .all(
          match,
          opts.accountId ?? null,
          opts.accountId ?? null,
          opts.chatJid ?? null,
          opts.chatJid ?? null,
          opts.limit
        ) as unknown as StoredMessage[]
    try {
      return run(opts.query)
    } catch {
      // Not valid FTS5 syntax: search the words literally.
      const literal = opts.query
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => `"${w.replace(/"/g, '""')}"`)
        .join(' ')
      return literal ? run(literal) : []
    }
  }

  getRawMessage(accountId: string, chatJid: string, id: string): string | undefined {
    const r = this.db
      .prepare('SELECT raw FROM messages WHERE account_id = ? AND chat_jid = ? AND id = ?')
      .get(accountId, this.resolveJid(accountId, chatJid), id) as Row | undefined
    return (r?.raw as string) ?? undefined
  }

  /** Lookup by message id only (Baileys' getMessage retry hook does not always know the chat). */
  getRawMessageById(accountId: string, id: string): string | undefined {
    const r = this.db.prepare('SELECT raw FROM messages WHERE account_id = ? AND id = ? LIMIT 1').get(accountId, id) as
      | Row
      | undefined
    return (r?.raw as string) ?? undefined
  }

  getMessage(accountId: string, chatJid: string, id: string): StoredMessage | undefined {
    return this.db
      .prepare(
        `SELECT account_id, chat_jid, id, from_me, sender_jid, sender_name, ts, type, text, media_type, media_path, quoted_id
         FROM messages WHERE account_id = ? AND chat_jid = ? AND id = ?`
      )
      .get(accountId, chatJid, id) as StoredMessage | undefined
  }

  editMessage(accountId: string, id: string, text: string): void {
    this.db.prepare('UPDATE messages SET text = ? WHERE account_id = ? AND id = ?').run(`${text} (editada)`, accountId, id)
  }

  revokeMessage(accountId: string, id: string): void {
    this.db
      .prepare(`UPDATE messages SET text = NULL, type = 'revoked', media_type = NULL WHERE account_id = ? AND id = ?`)
      .run(accountId, id)
  }

  setMediaPath(accountId: string, chatJid: string, id: string, path: string): void {
    this.db
      .prepare('UPDATE messages SET media_path = ? WHERE account_id = ? AND chat_jid = ? AND id = ?')
      .run(path, accountId, chatJid, id)
  }

  // ---------- approvals ----------

  insertApproval(a: Omit<ApprovalView, 'accountLabel'>): void {
    this.db
      .prepare(
        `INSERT INTO approvals (id, account_id, chat_jid, chat_name, kind, text, file_path, reply_to_id, created_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        a.id,
        a.accountId,
        a.chatJid,
        a.chatName,
        a.kind,
        a.text ?? null,
        a.filePath ?? null,
        a.replyToId ?? null,
        a.createdAt,
        a.status
      )
  }

  updateApproval(id: string, patch: { status: ApprovalStatus; text?: string; error?: string }): void {
    this.db
      .prepare('UPDATE approvals SET status = ?, text = COALESCE(?, text), error = ? WHERE id = ?')
      .run(patch.status, patch.text ?? null, patch.error ?? null, id)
  }

  /** Pending approvals cannot survive a restart: the request that created them is gone. */
  expireStaleApprovals(): void {
    this.db.prepare(`UPDATE approvals SET status = 'expired' WHERE status IN ('pending', 'approved')`).run()
  }

  listApprovals(limit = 100): ApprovalView[] {
    const rows = this.db
      .prepare(
        `SELECT a.*, COALESCE(acc.label, a.account_id) AS account_label FROM approvals a
         LEFT JOIN accounts acc ON acc.id = a.account_id
         ORDER BY (a.status = 'pending') DESC, a.created_at DESC LIMIT ?`
      )
      .all(limit) as Row[]
    return rows.map((r) => ({
      id: r.id as string,
      accountId: r.account_id as string,
      accountLabel: r.account_label as string,
      chatJid: r.chat_jid as string,
      chatName: r.chat_name as string,
      kind: r.kind as 'text' | 'file',
      text: (r.text as string) ?? undefined,
      filePath: (r.file_path as string) ?? undefined,
      replyToId: (r.reply_to_id as string) ?? undefined,
      createdAt: r.created_at as number,
      status: r.status as ApprovalStatus,
      error: (r.error as string) ?? undefined
    }))
  }

  // ---------- activity (audit log of what Claude did) ----------

  logActivity(a: { tool: string; accountId?: string; chatJid?: string; summary: string }): void {
    this.db
      .prepare('INSERT INTO activity (at, tool, account_id, chat_jid, summary) VALUES (?, ?, ?, ?, ?)')
      .run(Date.now(), a.tool, a.accountId ?? null, a.chatJid ?? null, a.summary)
    this.db.prepare('DELETE FROM activity WHERE id <= (SELECT MAX(id) - 2000 FROM activity)').run()
  }

  listActivity(limit = 200): ActivityView[] {
    const rows = this.db.prepare('SELECT * FROM activity ORDER BY id DESC LIMIT ?').all(limit) as Row[]
    return rows.map((r) => ({
      id: r.id as number,
      at: r.at as number,
      tool: r.tool as string,
      accountId: (r.account_id as string) ?? undefined,
      chatJid: (r.chat_jid as string) ?? undefined,
      summary: r.summary as string
    }))
  }
}

/**
 * Best name for chat `c` (joined with its contact row `ct`): group subject, address-book name,
 * WhatsApp profile name — also looking at contacts stored under an alias (the same person
 * known by phone number and by LID) — then the phone number, then the raw jid.
 */
const DISPLAY_NAME = `COALESCE(
  c.name, ct.name, ct.notify,
  (SELECT COALESCE(k.name, k.notify) FROM jid_alias a
     JOIN contacts k ON k.account_id = a.account_id AND k.jid = a.alias
    WHERE a.account_id = c.account_id AND a.jid = c.jid AND COALESCE(k.name, k.notify) IS NOT NULL LIMIT 1),
  ct.phone,
  (SELECT k.phone FROM jid_alias a
     JOIN contacts k ON k.account_id = a.account_id AND k.jid = a.alias
    WHERE a.account_id = c.account_id AND a.jid = c.jid AND k.phone IS NOT NULL LIMIT 1),
  c.jid)`

const CHAT_SELECT = `
  SELECT c.account_id, c.jid, c.is_group, c.level, c.last_message_at,
         ${DISPLAY_NAME} AS display_name
  FROM chats c
  LEFT JOIN contacts ct ON ct.account_id = c.account_id AND ct.jid = c.jid`

function toChatView(r: Row): ChatView {
  return {
    accountId: r.account_id as string,
    jid: r.jid as string,
    name: r.display_name as string,
    isGroup: !!r.is_group,
    level: r.level as PermissionLevel,
    lastMessageAt: (r.last_message_at as number) ?? undefined
  }
}
