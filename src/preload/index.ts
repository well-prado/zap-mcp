import { contextBridge, ipcRenderer } from 'electron'
import type { ZapApi } from '@shared/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const listen = (channel: string, cb: (...args: any[]) => void) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler = (_e: unknown, ...args: any[]) => cb(...args)
  ipcRenderer.on(channel, handler)
  return () => void ipcRenderer.removeListener(channel, handler)
}

const api: ZapApi = {
  getState: () => ipcRenderer.invoke('zap:getState'),
  addAccount: (label) => ipcRenderer.invoke('zap:addAccount', label),
  removeAccount: (id) => ipcRenderer.invoke('zap:removeAccount', id),
  reconnectAccount: (id) => ipcRenderer.invoke('zap:reconnectAccount', id),
  listChats: (q) => ipcRenderer.invoke('zap:listChats', q),
  setChatLevel: (accountId, jids, level) => ipcRenderer.invoke('zap:setChatLevel', accountId, jids, level),
  setSettings: (patch) => ipcRenderer.invoke('zap:setSettings', patch),
  listApprovals: () => ipcRenderer.invoke('zap:listApprovals'),
  decideApproval: (id, approve, editedText) => ipcRenderer.invoke('zap:decideApproval', id, approve, editedText),
  listActivity: () => ipcRenderer.invoke('zap:listActivity'),
  copy: (text) => ipcRenderer.invoke('zap:copy', text),
  openMcpb: () => ipcRenderer.invoke('zap:openMcpb'),
  onStateChanged: (cb) => listen('zap:state-changed', cb),
  onNavigate: (cb) => listen('zap:navigate', cb)
}

contextBridge.exposeInMainWorld('zap', api)
