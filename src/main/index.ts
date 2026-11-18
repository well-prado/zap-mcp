/**
 * Zap MCP — menu bar app. Owns the WhatsApp connections and the MCP server; the MCP server
 * exists only while this app runs, which is what makes "the Mac is the server" true.
 */
import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, Notification, shell, Tray } from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import pino from 'pino'
import type { AppSettings, AppState, ApprovalView, ChatQuery, PermissionLevel } from '@shared/types'
import { APP_DIR_NAME, CONNECTION_FILE } from '@shared/tools'
import { Approvals } from './approvals'
import { Store } from './db'
import { McpHttpServer } from './mcp'
import { AccountManager } from './whatsapp'

// Fixed data dir so the stdio bridge can find the connection file. ZAP_DATA_DIR is for development/tests.
const dataDir = process.env.ZAP_DATA_DIR ?? join(app.getPath('appData'), APP_DIR_NAME)
app.setPath('userData', dataDir)
mkdirSync(join(dataDir, 'logs'), { recursive: true })

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

const logger = pino({ level: process.env.ZAP_LOG_LEVEL ?? 'warn' }, pino.destination(join(dataDir, 'logs', 'whatsapp.log')))
const connectionPath = join(dataDir, CONNECTION_FILE)

let store: Store
let accounts: AccountManager
let approvals: Approvals
let mcp: McpHttpServer
let token: string
let tray: Tray | undefined
let win: BrowserWindow | undefined
let quitting = false

function mcpbPath(): string | undefined {
  const p = app.isPackaged ? join(process.resourcesPath, 'zap-mcp.mcpb') : join(app.getAppPath(), 'zap-mcp.mcpb')
  return existsSync(p) ? p : undefined
}

function state(): AppState {
  const settings = store.getSettings()
  const url = `http://127.0.0.1:${settings.mcpPort}/mcp`
  return {
    accounts: accounts.list().map((a) => a.view()),
    settings,
    pendingApprovals: approvals.pendingCount(),
    mcp: {
      running: mcp.running,
      url,
      port: settings.mcpPort,
      error: mcp.error,
      configPath: connectionPath,
      mcpbPath: mcpbPath(),
      claudeCodeCommand: `claude mcp add --transport http --scope user zap-mcp ${url} --header "Authorization: Bearer ${token}"`
    }
  }
}

async function startMcp(): Promise<void> {
  const { mcpPort } = store.getSettings()
  await mcp.start(mcpPort, token)
  if (mcp.running) {
    writeFileSync(connectionPath, JSON.stringify({ url: `http://127.0.0.1:${mcpPort}/mcp`, token }, null, 2), { mode: 0o600 })
  }
}

// ---------- window ----------

function showWindow(tab?: string): void {
  if (!win) {
    win = new BrowserWindow({
      width: 1000,
      height: 700,
      minWidth: 760,
      minHeight: 520,
      show: false,
      title: 'Zap MCP',
      titleBarStyle: 'hiddenInset',
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/index.cjs'),
        contextIsolation: true,
        sandbox: true
      }
    })
    win.on('close', (e) => {
      if (!quitting) {
        e.preventDefault()
        win?.hide()
      }
    })
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://')) void shell.openExternal(url)
      return { action: 'deny' }
    })
    if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
    else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
    win.once('ready-to-show', () => {
      win?.show()
      if (tab) win?.webContents.send('zap:navigate', tab)
    })
    return
  }
  win.show()
  win.focus()
  if (tab) win.webContents.send('zap:navigate', tab)
}

// ---------- tray ----------

const STATUS_LABEL: Record<string, string> = {
  starting: 'iniciando',
  qr: 'aguardando QR code',
  connecting: 'conectando…',
  connected: 'conectada',
  disconnected: 'desconectada',
  logged_out: 'desvinculada'
}

function rebuildTray(): void {
  if (!tray) return
  const s = state()
  const pending = s.pendingApprovals
  tray.setTitle(pending ? ` ${pending}` : '')
  tray.setToolTip(`Zap MCP — ${s.settings.paused ? 'Claude pausado' : 'Claude ativo'}`)
  const menu = Menu.buildFromTemplate([
    {
      label: s.mcp.running
        ? s.settings.paused
          ? 'Acesso do Claude: pausado'
          : 'Acesso do Claude: ativo'
        : `Servidor MCP parado${s.mcp.error ? ` — ${s.mcp.error}` : ''}`,
      enabled: false
    },
    { type: 'separator' },
    ...(s.accounts.length
      ? s.accounts.map((a) => ({
          label: `${a.label}${a.meJid ? ` (${a.meJid.split('@')[0]})` : ''} — ${STATUS_LABEL[a.status] ?? a.status}`,
          click: () => showWindow('accounts')
        }))
      : [{ label: 'Nenhuma conta conectada', enabled: false }]),
    { type: 'separator' },
    {
      label: pending ? `Aprovações pendentes (${pending})…` : 'Nenhuma aprovação pendente',
      enabled: pending > 0,
      click: () => showWindow('approvals')
    },
    { label: 'Abrir painel…', accelerator: 'Command+,', click: () => showWindow() },
    {
      label: 'Pausar acesso do Claude',
      type: 'checkbox',
      checked: s.settings.paused,
      click: (item) => {
        store.setSettings({ paused: item.checked })
        changed()
      }
    },
    { type: 'separator' },
    { label: 'Sair do Zap MCP', accelerator: 'Command+Q', click: () => app.quit() }
  ])
  tray.setContextMenu(menu)
}

function createTray(): void {
  const icon = nativeImage.createFromPath(join(app.getAppPath(), 'resources', 'trayTemplate.png'))
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  rebuildTray()
}

// ---------- change propagation ----------

let changeTimer: NodeJS.Timeout | undefined
function changed(): void {
  clearTimeout(changeTimer)
  changeTimer = setTimeout(() => {
    rebuildTray()
    win?.webContents.send('zap:state-changed')
  }, 150)
}

function notifyApproval(a: ApprovalView): void {
  if (!Notification.isSupported()) return
  const body = a.kind === 'file' ? `Arquivo: ${a.filePath}${a.text ? `\n${a.text}` : ''}` : (a.text ?? '')
  const n = new Notification({
    title: `Claude quer enviar em "${a.chatName}"`,
    subtitle: a.accountLabel,
    body: body.slice(0, 240),
    actions: [{ type: 'button', text: 'Aprovar' }],
    closeButtonText: 'Depois'
  })
  n.on('click', () => showWindow('approvals'))
  n.on('action', () => void approvals.decide(a.id, true).catch(() => {}))
  n.show()
}

// ---------- IPC ----------

function registerIpc(): void {
  ipcMain.handle('zap:getState', () => state())
  ipcMain.handle('zap:addAccount', async (_e, label: string) => (await accounts.add(label)).id)
  ipcMain.handle('zap:removeAccount', (_e, id: string) => accounts.remove(id))
  ipcMain.handle('zap:reconnectAccount', (_e, id: string) => accounts.get(id)?.start())
  ipcMain.handle('zap:listChats', (_e, q: ChatQuery) => store.listChats(q))
  ipcMain.handle('zap:setChatLevel', (_e, accountId: string, jids: string[], level: PermissionLevel) => {
    store.setChatLevel(accountId, jids, level)
    changed()
  })
  ipcMain.handle('zap:setSettings', async (_e, patch: Partial<AppSettings>) => {
    const before = store.getSettings()
    const after = store.setSettings(patch)
    if (patch.openAtLogin !== undefined) app.setLoginItemSettings({ openAtLogin: after.openAtLogin })
    if (patch.mcpPort !== undefined && patch.mcpPort !== before.mcpPort) await startMcp()
    changed()
    return after
  })
  ipcMain.handle('zap:listApprovals', () => store.listApprovals())
  ipcMain.handle('zap:decideApproval', (_e, id: string, approve: boolean, editedText?: string) =>
    approvals.decide(id, approve, editedText)
  )
  ipcMain.handle('zap:listActivity', () => store.listActivity())
  ipcMain.handle('zap:copy', (_e, text: string) => clipboard.writeText(text))
  ipcMain.handle('zap:openMcpb', async () => {
    const p = mcpbPath()
    if (p) await shell.openPath(p)
    return p
  })
}

// ---------- lifecycle ----------

app.on('second-instance', () => showWindow())
app.on('window-all-closed', () => {
  // Keep running in the menu bar.
})
app.on('before-quit', () => {
  quitting = true
})

app.whenReady().then(async () => {
  app.dock?.hide()

  store = new Store(join(dataDir, 'zap.db'))
  store.expireStaleApprovals()
  token = store.getSecret('mcpToken') ?? randomBytes(24).toString('hex')
  store.setSecret('mcpToken', token)

  accounts = new AccountManager(store, join(dataDir, 'media'), logger)
  approvals = new Approvals(store)
  mcp = new McpHttpServer({ store, accounts, approvals, version: app.getVersion() })

  accounts.on('changed', changed)
  accounts.on('data', changed)
  approvals.on('changed', changed)
  approvals.on('requested', (a: ApprovalView) => notifyApproval(a))

  registerIpc()
  createTray()
  await startMcp()
  changed()
  await accounts.startAll()

  if (!accounts.list().length || process.env.ZAP_SHOW_WINDOW) showWindow()
})

app.on('will-quit', (e) => {
  if (!accounts) return
  e.preventDefault()
  void Promise.allSettled([accounts.stopAll(), mcp.stop()]).finally(() => app.exit(0))
})
