#!/usr/bin/env bun
import { parseArgs } from './cli.ts'
import { WorkflowError } from './schemas.ts'
import { z } from 'zod'

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if ('command' in args && args.command === 'init') {
    const { bootstrapInstance } = await import('./bootstrap.ts')
    console.log(JSON.stringify(await bootstrapInstance(args.root, { id: args.id, target: args.target })))
    return
  }
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')
  const { createServer } = await import('./server.ts')
  const { root, agentTest } = args
  const allowed = agentTest ? [await (await import('./template.ts')).createAgentInstance(root)] : undefined
  const { server, idle } = await createServer({ root, allowed })
  const transport = new StdioServerTransport()
  let closing = false
  async function shutdown() {
    if (closing) return
    closing = true
    // SDK close aborts each request; wait for disposable cleanup and lock release.
    await server.close()
    await idle()
    process.exitCode = 0
  }
  server.onclose = () => { void shutdown() }
  process.stdin.once('end', () => { void shutdown() })
  process.stdin.once('close', () => { void shutdown() })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void shutdown() })
  await server.connect(transport)
}

try { await main() }
catch (error) {
  process.exitCode = 1
  if (process.env.WORKBASE_DEBUG === '1') console.error(error)
  else if (error instanceof WorkflowError) console.error(`error ${error.code}: ${error.message.replace(/[\r\n]+/g, ' ')}`)
  else if (error instanceof z.ZodError) console.error('error invalid_config: Configuration does not match the schema')
  // Unexpected errors keep their message and stack: suppressing them hides the real cause.
  else console.error(error)
}
