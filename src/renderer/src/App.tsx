import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  ActivityView,
  AppState,
  ApprovalView,
  ChatQuery,
  ChatView,
  NewChatPolicy,
  PermissionLevel,
  ZapApi
} from '@shared/types'

declare global {
  interface Window {
    zap: ZapApi
  }
}
const zap = window.zap

type Tab = 'accounts' | 'chats' | 'approvals' | 'activity' | 'claude'

const LEVELS: { value: PermissionLevel; label: string; hint: string }[] = [
  { value: 'blocked', label: 'Bloqueado', hint: 'O Claude nem sabe que este chat existe' },
  { value: 'read', label: 'Ler', hint: 'Ler, buscar e abrir mídias' },
  { value: 'draft', label: 'Ler + propor', hint: 'Mensagens do Claude esperam sua aprovação' },
  { value: 'send', label: 'Ler + enviar', hint: 'Texto sai direto, sem aprovação (arquivos sempre pedem)' }
]

const STATUS: Record<string, { label: string; tone: string }> = {
  starting: { label: 'Iniciando', tone: 'muted' },
  qr: { label: 'Escaneie o QR', tone: 'warn' },
  connecting: { label: 'Conectando…', tone: 'warn' },
  connected: { label: 'Conectada', tone: 'ok' },
  disconnected: { label: 'Desconectada', tone: 'muted' },
  logged_out: { label: 'Desvinculada', tone: 'bad' }
}

function useAppState(): [AppState | undefined, () => void] {
  const [state, setState] = useState<AppState>()
  const refresh = useCallback(() => void zap.getState().then(setState), [])
  useEffect(() => {
    refresh()
    return zap.onStateChanged(refresh)
  }, [refresh])
  return [state, refresh]
}

const fmtDate = (ms?: number) =>
  ms ? new Date(ms).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—'

export function App() {
  const [state] = useAppState()
  const [tab, setTab] = useState<Tab>('accounts')
  useEffect(() => zap.onNavigate((t) => setTab(t as Tab)), [])

  if (!state) return <div className="loading">Carregando…</div>

  const nav: { id: Tab; label: string; badge?: number }[] = [
    { id: 'accounts', label: 'Contas' },
    { id: 'chats', label: 'Chats e permissões' },
    { id: 'approvals', label: 'Aprovações', badge: state.pendingApprovals },
    { id: 'activity', label: 'Atividade do Claude' },
    { id: 'claude', label: 'Conectar ao Claude' }
  ]

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">Zap MCP</div>
        <nav>
          {nav.map((n) => (
            <button key={n.id} className={tab === n.id ? 'active' : ''} onClick={() => setTab(n.id)}>
              <span>{n.label}</span>
              {!!n.badge && <span className="badge">{n.badge}</span>}
            </button>
          ))}
        </nav>
        <div className={`server ${state.settings.paused ? 'paused' : state.mcp.running ? 'on' : 'off'}`}>
          <span className="dot" />
          {state.settings.paused ? 'Claude pausado' : state.mcp.running ? 'Servidor MCP ativo' : 'Servidor MCP parado'}
        </div>
      </aside>
      <main>
        {tab === 'accounts' && <Accounts state={state} />}
        {tab === 'chats' && <Chats state={state} />}
        {tab === 'approvals' && <Approvals />}
        {tab === 'activity' && <Activity />}
        {tab === 'claude' && <Claude state={state} />}
      </main>
    </div>
  )
}

// ---------------------------------------------------------------------------

function Accounts({ state }: { state: AppState }) {
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)

  const add = async () => {
    setBusy(true)
    try {
      await zap.addAccount(label)
      setLabel('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <header>
        <h1>Contas do WhatsApp</h1>
        <p>
          Cada conta vira um “aparelho conectado” no seu celular, como o WhatsApp Web. O celular continua funcionando
          normalmente.
        </p>
      </header>

      <div className="cards">
        {state.accounts.map((a) => {
          const st = STATUS[a.status] ?? { label: a.status, tone: 'muted' }
          return (
            <div className="card account" key={a.id}>
              <div className="row">
                <div>
                  <div className="title">{a.label}</div>
                  <div className="sub">
                    {a.meJid ? `+${a.meJid.split('@')[0]}` : 'Ainda não vinculada'}
                    {a.meName ? ` · ${a.meName}` : ''}
                  </div>
                </div>
                <span className={`pill ${st.tone}`}>{st.label}</span>
              </div>
              {a.qr && (
                <div className="qr">
                  <img src={a.qr} alt="QR code" />
                  <ol>
                    <li>Abra o WhatsApp no celular</li>
                    <li>
                      Toque em <b>Aparelhos conectados</b> → <b>Conectar um aparelho</b>
                    </li>
                    <li>Aponte a câmera para este código</li>
                  </ol>
                </div>
              )}
              {a.lastError && <div className="error">{a.lastError}</div>}
              <div className="actions">
                {(a.status === 'disconnected' || a.status === 'logged_out') && (
                  <button onClick={() => zap.reconnectAccount(a.id)}>Conectar</button>
                )}
                <button
                  className="danger"
                  onClick={() => {
                    if (confirm(`Remover "${a.label}"? Este Mac será desvinculado e o histórico local apagado.`)) {
                      void zap.removeAccount(a.id)
                    }
                  }}
                >
                  Remover
                </button>
              </div>
            </div>
          )
        })}

        <div className="card add">
          <div className="title">Adicionar conta</div>
          <input placeholder="Nome (ex.: Trabalho)" value={label} onChange={(e) => setLabel(e.target.value)} />
          <button className="primary" disabled={busy} onClick={add}>
            {busy ? 'Gerando QR…' : 'Gerar QR code'}
          </button>
          <p className="fine">
            Uso não oficial do WhatsApp: existe risco de o número ser banido. Teste primeiro com um número secundário.
          </p>
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------

function LevelPicker({ value, onChange }: { value: PermissionLevel; onChange: (l: PermissionLevel) => void }) {
  return (
    <div className="seg" role="radiogroup">
      {LEVELS.map((l) => (
        <button
          key={l.value}
          title={l.hint}
          role="radio"
          aria-checked={value === l.value}
          className={`${value === l.value ? 'on' : ''} lvl-${l.value}`}
          onClick={() => onChange(l.value)}
        >
          {l.label}
        </button>
      ))}
    </div>
  )
}

function Chats({ state }: { state: AppState }) {
  const accounts = state.accounts
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<ChatQuery['filter']>('all')
  const [chats, setChats] = useState<ChatView[]>([])

  useEffect(() => {
    if (!accountId && accounts[0]) setAccountId(accounts[0].id)
  }, [accounts, accountId])

  const load = useCallback(() => {
    if (accountId) void zap.listChats({ accountId, search, filter }).then(setChats)
  }, [accountId, search, filter])
  useEffect(load, [load])
  useEffect(() => zap.onStateChanged(load), [load])

  const visible = useMemo(() => chats.slice(0, 400), [chats])
  const enabled = chats.filter((c) => c.level !== 'blocked').length

  const setLevel = async (jids: string[], level: PermissionLevel) => {
    await zap.setChatLevel(accountId, jids, level)
    load()
  }

  if (!accounts.length) return <Empty text="Conecte uma conta primeiro, na aba Contas." />

  return (
    <section>
      <header>
        <h1>Chats e permissões</h1>
        <p>
          O Claude só enxerga o que você liberar aqui. A regra é aplicada pelo app, não pelo Claude: chat bloqueado não
          aparece em nenhuma ferramenta.
        </p>
      </header>

      <div className="policy card">
        <div>
          <div className="title">Chats novos</div>
          <div className="sub">Nível dado a conversas que o app ainda não conhecia.</div>
        </div>
        <select
          value={state.settings.newChatPolicy}
          onChange={(e) => void zap.setSettings({ newChatPolicy: e.target.value as NewChatPolicy })}
        >
          <option value="blocked">Bloqueado (recomendado)</option>
          <option value="read">Ler</option>
          <option value="draft">Ler + propor</option>
        </select>
      </div>

      <div className="toolbar">
        {accounts.length > 1 && (
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        )}
        <input className="grow" placeholder="Buscar chat…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={filter} onChange={(e) => setFilter(e.target.value as ChatQuery['filter'])}>
          <option value="all">Todos</option>
          <option value="groups">Grupos</option>
          <option value="direct">Conversas privadas</option>
          <option value="enabled">Liberados</option>
        </select>
      </div>

      <div className="bulk">
        <span>
          {chats.length} chats · {enabled} liberados
        </span>
        <span className="grow" />
        <span>Aplicar aos {chats.length} listados:</span>
        {LEVELS.map((l) => (
          <button
            key={l.value}
            className="link"
            onClick={() => {
              if (confirm(`Mudar ${chats.length} chats para "${l.label}"?`)) void setLevel(chats.map((c) => c.jid), l.value)
            }}
          >
            {l.label}
          </button>
        ))}
      </div>

      <div className="list">
        {visible.map((c) => (
          <div className="chat" key={c.jid}>
            <div className="avatar">{c.isGroup ? '👥' : '👤'}</div>
            <div className="grow">
              <div className="title">{c.name}</div>
              <div className="sub">
                {c.isGroup ? 'Grupo' : 'Privado'} · última mensagem {fmtDate(c.lastMessageAt)}
              </div>
            </div>
            <LevelPicker value={c.level} onChange={(l) => void setLevel([c.jid], l)} />
          </div>
        ))}
        {!chats.length && <Empty text="Nenhum chat ainda. Eles aparecem conforme o histórico sincroniza." />}
        {chats.length > visible.length && <div className="more">Mostrando 400 de {chats.length}. Use a busca.</div>}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------

function Approvals() {
  const [items, setItems] = useState<ApprovalView[]>([])
  const [edits, setEdits] = useState<Record<string, string>>({})
  const load = useCallback(() => void zap.listApprovals().then(setItems), [])
  useEffect(() => {
    load()
    return zap.onStateChanged(load)
  }, [load])

  const pending = items.filter((a) => a.status === 'pending')
  const history = items.filter((a) => a.status !== 'pending')

  const decide = async (a: ApprovalView, approve: boolean) => {
    await zap.decideApproval(a.id, approve, edits[a.id])
    load()
  }

  return (
    <section>
      <header>
        <h1>Aprovações</h1>
        <p>Mensagens que o Claude quer enviar. Você pode editar o texto antes de aprovar.</p>
      </header>
      {!pending.length && <Empty text="Nada esperando aprovação." />}
      <div className="cards">
        {pending.map((a) => (
          <div className="card approval" key={a.id}>
            <div className="sub">
              {a.accountLabel} → <b>{a.chatName}</b> · {fmtDate(a.createdAt)}
            </div>
            {a.kind === 'file' && <div className="file">📎 {a.filePath}</div>}
            <textarea
              rows={Math.min(10, Math.max(3, (edits[a.id] ?? a.text ?? '').split('\n').length + 1))}
              placeholder={a.kind === 'file' ? 'Legenda (opcional)' : ''}
              value={edits[a.id] ?? a.text ?? ''}
              onChange={(e) => setEdits({ ...edits, [a.id]: e.target.value })}
            />
            <div className="actions">
              <button className="danger" onClick={() => decide(a, false)}>
                Rejeitar
              </button>
              <button className="primary" onClick={() => decide(a, true)}>
                Aprovar e enviar
              </button>
            </div>
          </div>
        ))}
      </div>
      {!!history.length && (
        <>
          <h2>Histórico</h2>
          <table>
            <tbody>
              {history.map((a) => (
                <tr key={a.id}>
                  <td className="nowrap">{fmtDate(a.createdAt)}</td>
                  <td>{a.chatName}</td>
                  <td className="clip">{a.kind === 'file' ? `📎 ${a.filePath}` : a.text}</td>
                  <td>
                    <span className={`pill ${a.status === 'sent' ? 'ok' : a.status === 'failed' ? 'bad' : 'muted'}`}>
                      {{ sent: 'Enviada', rejected: 'Rejeitada', failed: 'Falhou', expired: 'Expirada', approved: 'Enviando' }[
                        a.status as string
                      ] ?? a.status}
                    </span>
                    {a.error && <div className="error small">{a.error}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------

function Activity() {
  const [items, setItems] = useState<ActivityView[]>([])
  useEffect(() => {
    const load = () => void zap.listActivity().then(setItems)
    load()
    return zap.onStateChanged(load)
  }, [])
  return (
    <section>
      <header>
        <h1>Atividade do Claude</h1>
        <p>Tudo o que o Claude pediu ao app, mais recente primeiro.</p>
      </header>
      {!items.length && <Empty text="O Claude ainda não usou o Zap MCP." />}
      <table>
        <tbody>
          {items.map((a) => (
            <tr key={a.id}>
              <td className="nowrap">{fmtDate(a.at)}</td>
              <td>
                <code>{a.tool}</code>
              </td>
              <td>{a.summary}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

// ---------------------------------------------------------------------------

function Claude({ state }: { state: AppState }) {
  const [copied, setCopied] = useState('')
  const [port, setPort] = useState(String(state.mcp.port))
  const s = state.settings
  const copy = (what: string, text: string) => {
    void zap.copy(text)
    setCopied(what)
    setTimeout(() => setCopied(''), 1500)
  }

  return (
    <section>
      <header>
        <h1>Conectar ao Claude</h1>
        <p>O servidor MCP só existe enquanto este app está aberto. Fechou o app, o Claude perde o acesso.</p>
      </header>

      <div className="cards">
        <div className="card">
          <div className="title">Claude Desktop</div>
          <p className="sub">Instale a extensão uma vez. Ela só repassa os pedidos do Claude para este app.</p>
          {state.mcp.mcpbPath ? (
            <button className="primary" onClick={() => zap.openMcpb()}>
              Instalar extensão no Claude Desktop
            </button>
          ) : (
            <p className="fine">
              Extensão ainda não empacotada. No projeto, rode <code>npm run pack:mcpb</code> e reabra o app.
            </p>
          )}
        </div>

        <div className="card">
          <div className="title">Claude Code</div>
          <p className="sub">Rode no terminal (contém o token de acesso deste Mac):</p>
          <pre className="cmd">{state.mcp.claudeCodeCommand.replace(/Bearer \w+/, 'Bearer ••••••')}</pre>
          <button onClick={() => copy('cc', state.mcp.claudeCodeCommand)}>
            {copied === 'cc' ? 'Copiado!' : 'Copiar comando'}
          </button>
        </div>

        <div className="card">
          <div className="title">Servidor</div>
          <div className="sub">
            {state.mcp.running ? `Ouvindo em ${state.mcp.url}` : `Parado${state.mcp.error ? `: ${state.mcp.error}` : ''}`}
          </div>
          <label className="check">
            <input type="checkbox" checked={s.paused} onChange={(e) => void zap.setSettings({ paused: e.target.checked })} />
            Pausar acesso do Claude (todas as ferramentas respondem “pausado”)
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={s.syncFullHistory}
              onChange={(e) => void zap.setSettings({ syncFullHistory: e.target.checked })}
            />
            Baixar o histórico completo ao vincular uma conta
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={s.openAtLogin}
              onChange={(e) => void zap.setSettings({ openAtLogin: e.target.checked })}
            />
            Abrir junto com o Mac
          </label>
          <div className="row">
            <label>
              Porta{' '}
              <input className="port" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} />
            </label>
            <button
              disabled={Number(port) === state.mcp.port || Number(port) < 1024 || Number(port) > 65535}
              onClick={() => void zap.setSettings({ mcpPort: Number(port) })}
            >
              Aplicar
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}

function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>
}
