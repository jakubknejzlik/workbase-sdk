// Test startup configuration, deliberately separate from instance-controlled files.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from '../../src/server.ts'

const [root, ...dependencyRoots] = process.argv.slice(2)
const app = await createServer({ root, allowed: ['fresh-instance'], dependencyRoots })
await app.server.connect(new StdioServerTransport())
process.stdin.once('end', () => { void app.server.close() })
