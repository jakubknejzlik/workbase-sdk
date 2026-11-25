#!/usr/bin/env bun
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server.ts'

try {
  if (process.argv.length > 2) throw new Error('invalid_arguments')
  const server = createServer()
  let closing = false
  const shutdown = async () => {
    if (closing) return
    closing = true
    try { await server.close() } catch { process.exitCode = 1 }
  }
  process.stdin.once('end', () => { void shutdown() })
  process.stdin.once('close', () => { void shutdown() })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void shutdown() })
  await server.connect(new StdioServerTransport())
} catch {
  // Startup failures are silent: stderr and log files must never carry credentials.
  process.exitCode = 1
}
