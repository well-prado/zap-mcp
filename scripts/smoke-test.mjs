// Smoke test for a packaged Zap MCP build (used by the release workflow on macOS, Windows and Linux).
// Launches the app with a throwaway data folder and talks to its MCP server the way Claude Code does.
// Usage: node scripts/smoke-test.mjs <app executable> [extra app args...]
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const [exe, ...extraArgs] = process.argv.slice(2)
const dataDir = mkdtempSync(join(tmpdir(), 'zap-smoke-'))
const app = spawn(exe, extraArgs, {
  env: { ...process.env, ZAP_DATA_DIR: dataDir, ZAP_MCP_PORT: process.env.ZAP_MCP_PORT ?? '47899' },
  stdio: 'inherit'
})
let exitCode = null
app.on('exit', (code) => (exitCode = code ?? -1))

const fail = (message) => {
  console.error(`FAIL ${message}`)
  app.kill()
  process.exit(1)
}

const connectionFile = join(dataDir, 'mcp-connection.json')
const deadline = Date.now() + 90_000
while (!existsSync(connectionFile)) {
  if (exitCode !== null) fail(`the app exited early (code ${exitCode})`)
  if (Date.now() > deadline) fail('the MCP server did not start within 90 s')
  await new Promise((r) => setTimeout(r, 500))
}
const conn = JSON.parse(readFileSync(connectionFile, 'utf8'))

const unauthenticated = await fetch(conn.url, { method: 'POST' })
if (unauthenticated.status !== 401) fail(`expected 401 without a token, got ${unauthenticated.status}`)

const client = new Client({ name: 'zap-smoke-test', version: '0' })
await client.connect(
  new StreamableHTTPClientTransport(new URL(conn.url), { requestInit: { headers: { Authorization: `Bearer ${conn.token}` } } })
)
const tools = (await client.listTools()).tools.map((t) => t.name)
if (tools.length !== 7) fail(`expected 7 tools, got: ${tools.join(', ')}`)
const accounts = await client.callTool({ name: 'list_accounts', arguments: {} })
if (accounts.isError || accounts.content[0].text.trim() !== '[]') fail(`list_accounts on a fresh install: ${accounts.content[0].text}`)

console.log(`PASS ${process.platform}-${process.arch}: app started, database created, MCP rejects calls without a token, ${tools.length} tools, list_accounts works`)
await client.close()
app.kill()
setTimeout(() => process.exit(0), 1000)
