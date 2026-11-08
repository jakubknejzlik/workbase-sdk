import { createServer } from 'node:http'
import { z } from 'zod'
import { LlmConfigProposer, RuleConfigProposer, promptSchema, type ConfigProposer } from '@workbasehq/core/config-proposals'
import { ConfigDrafts } from './config-drafts'
import { WorkflowError } from './schemas'
import { Store } from './storage'

/** Optional JSON gateway adapter. The gateway owns provider-specific authentication/protocol. */
export function configuredProposer(env: Record<string, string | undefined>): ConfigProposer {
  if (!env.CONFIG_PROPOSER || env.CONFIG_PROPOSER === 'rules') return new RuleConfigProposer()
  if (env.CONFIG_PROPOSER !== 'llm' || !env.CONFIG_PROPOSER_URL || !env.CONFIG_PROPOSER_KEY) throw new Error('LLM proposer requires CONFIG_PROPOSER_URL and CONFIG_PROPOSER_KEY')
  const url = env.CONFIG_PROPOSER_URL; const key = env.CONFIG_PROPOSER_KEY
  return new LlmConfigProposer({ async complete(input) {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(input), signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new WorkflowError('proposer_unavailable', 'Proposal provider unavailable', 502)
    return response.json()
  } })
}
const inputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('history'), instance: z.string() }),
  z.strictObject({ action: z.literal('propose'), instance: z.string(), prompt: promptSchema }),
  z.strictObject({ action: z.literal('apply'), instance: z.string(), proposalId: z.uuid() }),
])
/** Loopback-only companion. Worker scope/grant checks precede this authenticated hop. */
export async function startConfigEditor(options: { root: string; instances: string[]; token: string; port?: number; proposer?: ConfigProposer }) {
  if (options.token.length < 32) throw new Error('Editor token must have at least 32 characters')
  const store = new Store(options.root, new Set(options.instances)); await store.init()
  const drafts = new ConfigDrafts(store, options.proposer)
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'private, no-store')
    response.setHeader('Content-Type', 'application/json')
    if (request.method !== 'POST' || request.url !== '/' || request.headers.authorization !== `Bearer ${options.token}` || request.headers.origin) {
      response.writeHead(403); response.end(JSON.stringify({ error: 'forbidden' })); return
    }
    try {
      let body = ''
      for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 10000) throw new WorkflowError('invalid_input', 'Request too large', 413) }
      const input = inputSchema.parse(JSON.parse(body))
      const result = input.action === 'history' ? await drafts.history(input.instance) : input.action === 'propose' ? await drafts.propose(input.instance, input.prompt) : await drafts.apply(input.instance, input.proposalId)
      response.end(JSON.stringify(result))
    } catch (error) {
      const status = error instanceof WorkflowError ? error.status : 400
      const message = error instanceof WorkflowError ? error.code : 'proposal_refused'
      response.writeHead(status)
      response.end(JSON.stringify({ error: message, message: error instanceof Error ? error.message : String(error) }))
    }
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Editor failed to bind')
  return { url: `http://127.0.0.1:${address.port}`, stop: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}
