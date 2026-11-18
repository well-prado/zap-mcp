/**
 * stdio bridge for Claude Desktop (packaged as zap-mcp.mcpb).
 *
 * Claude Desktop launches this process; it forwards every tool call to the Zap MCP app's
 * local HTTP server. It always advertises the tools, so they don't vanish from Claude when
 * the app is closed: calls just answer "open Zap MCP on your Mac".
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { APP_DIR_NAME, CONNECTION_FILE, SERVER_INSTRUCTIONS, TOOLS, type ToolName } from '../shared/tools'

const VERSION = '0.1.0'
const connectionFile =
  process.env.ZAP_MCP_CONNECTION ?? join(homedir(), 'Library', 'Application Support', APP_DIR_NAME, CONNECTION_FILE)

const notRunning = (detail?: string): CallToolResult => ({
  isError: true,
  content: [
    {
      type: 'text',
      text: `O app Zap MCP não está rodando neste Mac. Peça ao usuário para abri-lo (ele fica na barra de menus) e tente de novo.${detail ? ` (${detail})` : ''}`
    }
  ]
})

let client: Client | undefined
let clientKey: string | undefined

async function getClient(): Promise<Client | CallToolResult> {
  let conn: { url: string; token: string }
  try {
    conn = JSON.parse(readFileSync(connectionFile, 'utf8'))
  } catch {
    return notRunning('arquivo de conexão não encontrado')
  }
  const key = `${conn.url}|${conn.token}`
  if (client && clientKey === key) return client

  await client?.close().catch(() => {})
  const c = new Client({ name: 'zap-mcp-bridge', version: VERSION })
  const transport = new StreamableHTTPClientTransport(new URL(conn.url), {
    requestInit: { headers: { Authorization: `Bearer ${conn.token}` } }
  })
  try {
    await c.connect(transport)
  } catch (err) {
    return notRunning(err instanceof Error ? err.message : undefined)
  }
  client = c
  clientKey = key
  return c
}

async function forward(name: ToolName, args: unknown): Promise<CallToolResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const c = await getClient()
    if (!(c instanceof Client)) return c
    try {
      return (await c.callTool({ name, arguments: args as Record<string, unknown> })) as CallToolResult
    } catch (err) {
      // The app may have restarted since we connected; reconnect once.
      client = undefined
      clientKey = undefined
      if (attempt === 1) return notRunning(err instanceof Error ? err.message : undefined)
    }
  }
  return notRunning()
}

const server = new McpServer({ name: 'zap-mcp', version: VERSION }, { instructions: SERVER_INSTRUCTIONS })
for (const name of Object.keys(TOOLS) as ToolName[]) {
  const def = TOOLS[name]
  server.registerTool(
    name,
    {
      title: def.title,
      description: def.description,
      inputSchema: def.inputSchema,
      annotations: { readOnlyHint: def.readOnly, destructiveHint: false, openWorldHint: true }
    },
    async (args: unknown) => forward(name, args)
  )
}

await server.connect(new StdioServerTransport())
