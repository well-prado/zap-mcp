/**
 * What Claude may do in a chat.
 *  - blocked: the chat does not exist as far as Claude is concerned
 *  - read:    Claude can list, read and search it
 *  - draft:   read + Claude can propose messages, which you approve in the app
 *  - send:    read + Claude can send text without asking (files always need approval)
 */
export type PermissionLevel = 'blocked' | 'read' | 'draft' | 'send'
export const PERMISSION_LEVELS: PermissionLevel[] = ['blocked', 'read', 'draft', 'send']

/** Level given to a chat the app has never seen before. `send` is deliberately not offered. */
export type NewChatPolicy = Exclude<PermissionLevel, 'send'>

export type AccountStatus = 'starting' | 'qr' | 'connecting' | 'connected' | 'disconnected' | 'logged_out'

export interface AccountView {
  id: string
  label: string
  status: AccountStatus
  meJid?: string
  meName?: string
  /** QR code as a data: URL, present while status === 'qr' */
  qr?: string
  lastError?: string
}

export interface ChatView {
  accountId: string
  jid: string
  name: string
  isGroup: boolean
  level: PermissionLevel
  lastMessageAt?: number
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'sent' | 'failed' | 'expired'

export interface ApprovalView {
  id: string
  accountId: string
  accountLabel: string
  chatJid: string
  chatName: string
  kind: 'text' | 'file'
  text?: string
  filePath?: string
  replyToId?: string
  createdAt: number
  status: ApprovalStatus
  error?: string
}

export interface ActivityView {
  id: number
  at: number
  tool: string
  accountId?: string
  chatJid?: string
  summary: string
}

export type WhisperModelId = 'base' | 'large-v3-turbo-q5_0'
export type WhisperLanguage = 'auto' | 'pt' | 'en' | 'es'

export interface WhisperModelInfo {
  id: WhisperModelId
  label: string
  description: string
  bytes: number
}

/** Optional local speech-to-text (whisper.cpp). Nothing is downloaded until the user asks. */
export interface WhisperStatus {
  state: 'off' | 'installing' | 'ready' | 'error'
  /** Installed model (state 'ready') or the one being installed. */
  model?: WhisperModelId
  models: WhisperModelInfo[]
  progress?: { step: 'engine' | 'model'; received: number; total: number }
  error?: string
  /** Disk space used by the engine and models. */
  diskBytes: number
  /** Voice notes / audio in allowed chats that have no transcript yet. */
  untranscribed: number
  worker: { running: boolean; backfill: boolean; done: number; failed: number }
  /** An engine build exists for this OS/CPU (macOS arm64, Windows x64, Linux x64). */
  supported: boolean
  /** Runs on the GPU (Metal on macOS) rather than the CPU. */
  gpu: boolean
}

export interface AppSettings {
  newChatPolicy: NewChatPolicy
  /** Kill switch: every MCP tool call fails while paused. */
  paused: boolean
  syncFullHistory: boolean
  openAtLogin: boolean
  mcpPort: number
  /** Installed Whisper model, or null when transcription is off. */
  whisperModel: WhisperModelId | null
  whisperLanguage: WhisperLanguage
  /** Transcribe new voice notes in allowed chats as they arrive. */
  whisperAuto: boolean
  /** Auto-transcription only covers messages from this moment on (older ones: backfill button or on demand). */
  whisperAutoSince: number
}

export interface McpInfo {
  running: boolean
  url: string
  port: number
  error?: string
  claudeCodeCommand: string
  configPath: string
  mcpbPath?: string
}

export interface AppState {
  accounts: AccountView[]
  settings: AppSettings
  mcp: McpInfo
  pendingApprovals: number
  whisper: WhisperStatus
  /** process.platform of the computer running the app. */
  platform: string
}

export interface ChatQuery {
  accountId: string
  search?: string
  filter?: 'all' | 'groups' | 'direct' | 'enabled'
}

/** API the preload script exposes to the renderer as `window.zap`. */
export interface ZapApi {
  getState(): Promise<AppState>
  addAccount(label: string): Promise<string>
  removeAccount(id: string): Promise<void>
  reconnectAccount(id: string): Promise<void>
  listChats(q: ChatQuery): Promise<ChatView[]>
  setChatLevel(accountId: string, jids: string[], level: PermissionLevel): Promise<void>
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  listApprovals(): Promise<ApprovalView[]>
  decideApproval(id: string, approve: boolean, editedText?: string): Promise<void>
  listActivity(): Promise<ActivityView[]>
  copy(text: string): Promise<void>
  openMcpb(): Promise<string | undefined>
  whisperInstall(model: WhisperModelId): Promise<void>
  whisperCancel(): Promise<void>
  whisperRemove(): Promise<void>
  whisperBackfill(run: boolean): Promise<void>
  onStateChanged(cb: () => void): () => void
  onNavigate(cb: (tab: string) => void): () => void
}
