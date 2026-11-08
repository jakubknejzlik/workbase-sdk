#!/usr/bin/env bun
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server.ts'
import { ToolError } from './client.ts'
try {
  const server = createServer()
  let closing = false
  const shutdown = async () => { if (closing) return; closing = true; await server.close() }
  process.stdin.once('end', () => { void shutdown() })
  process.stdin.once('close', () => { void shutdown() })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void shutdown() })
  await server.connect(new StdioServerTransport())
} catch (error) {
  process.stderr.write(JSON.stringify({ code: error instanceof ToolError ? error.code : 'startup_failed', status: error instanceof ToolError ? error.status : 500 }) + '\n')
  process.exitCode = 1
}
