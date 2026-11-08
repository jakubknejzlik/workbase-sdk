import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from '../../src/data/server'

/** Real MCP protocol with an injectable HTTP transport; no duplicate query engine. */
export async function queryClient(request: typeof fetch, token: string, org = 'org-a') {
  const server = createServer({ WORKBASE_BASE_URL: 'http://localhost', WORKBASE_TOKEN: token, WORKBASE_ORG_ID: org }, request)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'query-parity', version: '1' })
  await server.connect(b); await client.connect(a)
  return { client, close: async () => { await client.close(); await server.close() } }
}
