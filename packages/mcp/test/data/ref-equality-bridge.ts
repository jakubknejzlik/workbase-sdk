import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from '../../src/data/server'

/** Real MCP protocol + HTTP adapter; the core worker test supplies actual D1 HTTP. */
export async function connectEqualityDataMcp(request: typeof fetch) {
  const server = createServer({ WORKBASE_BASE_URL: 'http://localhost', WORKBASE_TOKEN: 'synthetic-owner-a', WORKBASE_ORG_ID: 'org-a' }, request)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'equality-d1', version: '1' })
  await server.connect(b); await client.connect(a)
  return {
    call: async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })).structuredContent as Record<string, any>,
    close: async () => { await client.close(); await server.close() },
  }
}
