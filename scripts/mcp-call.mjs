// Dev helper: call one Zap MCP tool over HTTP, exactly as Claude Code would. Usage: node scripts/mcp-call.mjs <tool> '<json args>'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
const conn = JSON.parse(readFileSync(`${homedir()}/Library/Application Support/Zap MCP/mcp-connection.json`, 'utf8'))
const c = new Client({ name: 'zap-test', version: '0' })
await c.connect(new StreamableHTTPClientTransport(new URL(conn.url), { requestInit: { headers: { Authorization: `Bearer ${conn.token}` } } }))
const r = await c.callTool({ name: process.argv[2], arguments: JSON.parse(process.argv[3] ?? '{}') })
let i = 0
for (const part of r.content) {
  if (part.type === 'image') {
    const f = `${process.env.OUT_DIR ?? '.'}/mcp-image-${i++}.${part.mimeType.split('/')[1]}`
    writeFileSync(f, Buffer.from(part.data, 'base64'))
    console.log(`[image ${part.mimeType}, ${Math.round(part.data.length * 0.75 / 1024)} KB → ${f}]`)
  } else console.log(part.text)
}
if (r.isError) console.log('(isError)')
await c.close()
