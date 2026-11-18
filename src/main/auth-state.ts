/**
 * Baileys auth state kept in SQLite, one row per key, scoped by account.
 * Mirrors Baileys' useMultiFileAuthState, which its authors say not to use in production.
 */
import { BufferJSON, initAuthCreds, proto, type AuthenticationState, type SignalDataTypeMap } from 'baileys'
import type { Store } from './db'

export function useSqliteAuthState(store: Store, accountId: string): {
  state: AuthenticationState
  saveCreds: () => void
} {
  const stored = store.readCreds(accountId)
  const creds = stored ? JSON.parse(stored, BufferJSON.reviver) : initAuthCreds()

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const found = store.readKeys(accountId, type, ids)
          const out: { [id: string]: SignalDataTypeMap[T] } = {}
          for (const id of ids) {
            const raw = found.get(id)
            if (raw === undefined) continue
            let value = JSON.parse(raw, BufferJSON.reviver)
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value)
            }
            out[id] = value
          }
          return out
        },
        set: async (data) => {
          const entries: { type: string; id: string; value: string | null }[] = []
          for (const type of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
            const byId = data[type] ?? {}
            for (const id of Object.keys(byId)) {
              const value = byId[id]
              entries.push({ type, id, value: value ? JSON.stringify(value, BufferJSON.replacer) : null })
            }
          }
          store.writeKeys(accountId, entries)
        }
      }
    },
    saveCreds: () => store.writeCreds(accountId, JSON.stringify(creds, BufferJSON.replacer))
  }
}
