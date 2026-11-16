import { AsyncLocalStorage } from 'node:async_hooks'
import '@workbasehq/plugins/local-auth/better-auth-als-preseed'
import { createApp, type RuntimeEnv } from '@workbasehq/core'
import { neutralConfig } from './config'
import { causeChain, operationFor, diagnosticDatabase } from './workflow-diagnostics'

// Only this e2e Worker contains the control route. No scheduler or workflow is executed.
const config = neutralConfig()
let app: ReturnType<typeof createApp> | undefined
const operations = new AsyncLocalStorage<{ operation: string; path: string }>()
let diagnosedEnv: RuntimeEnv | undefined
let sequence = 0
const reads = new Map<string, { id: string; status: string }>()
const rendered = new Set<string>()
export default { async fetch(request: Request, env: RuntimeEnv & { C5_CONTROL_TOKEN: string }, ctx: ExecutionContext) {
  const path = new URL(request.url).pathname
  const operation = operationFor(request.method, path)
  const log = (status: number, error?: unknown) => console.log(JSON.stringify({ operation, method: request.method, path, status, causes: causeChain(error) }))
  return operations.run({ operation, path }, async () => {
    try {
      if (!diagnosedEnv) diagnosedEnv = { ...env, DB: diagnosticDatabase(env.DB, error => console.error(JSON.stringify({ ...operations.getStore(), causes: causeChain(error) }))) }
      const liveEnv = diagnosedEnv
      if (path.startsWith('/__test/')) {
        if (request.headers.get('Authorization') !== `Bearer ${env.C5_CONTROL_TOKEN}`) return new Response('Unauthorized', { status: 401 })
        if (path !== '/__test/c5' || request.method !== 'POST') return new Response('Not found', { status: 404 })
        const { action, id, token } = await request.json() as { action: string; id: string; token?: string }
        if (!['c5-terminal', 'c5-unmount'].includes(id)) return new Response('Unknown run', { status: 400 })
        if (action === 'rendered') {
          const read = token ? reads.get(token) : undefined
          if (read?.id !== id || read.status !== 'running') return new Response('Missing nonterminal read', { status: 409 })
          rendered.add(id)
        } else if (action === 'complete') {
          if (!rendered.has(id)) return new Response('Render barrier not acknowledged', { status: 409 })
          const result = await liveEnv.DB.prepare("UPDATE workflow_runs SET status='completed',updated_at=? WHERE id=? AND status='running'").bind(new Date().toISOString(), id).run()
          if (result.meta.changes !== 1) throw new Error('Expected one running fixture row')
        } else return new Response('Unknown action', { status: 400 })
        log(200)
        return Response.json({ ok: true, id, action })
      }
      app ??= createApp(config, liveEnv)
      const response = await app.fetch(request, liveEnv, ctx)
      if (operation === 'browser-workflow-GET') {
        log(response.status)
        if (response.ok && /^\/workflows\/c5-/.test(path)) {
          const run = await response.clone().json() as { id: string; status: string }
          const token = String(++sequence)
          reads.set(token, { id: run.id, status: run.status })
          response.headers.set('X-C5-Read', token)
        }
      }
      return response
    } catch (error) {
      log(500, error)
      return Response.json({ operation, causes: causeChain(error) }, { status: 500 })
    }
  })
} }
