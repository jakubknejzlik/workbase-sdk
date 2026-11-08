import '@workbasehq/plugins/local-auth/better-auth-als-preseed'
import { createApp, type RuntimeEnv } from '@workbasehq/core'
import { relayAudit } from '../../../plugins/audit/src/relay'
import { createEntity } from '../../../core/src/migrations/schema'
import { neutralConfig } from './config'
const apps = new Map<boolean, ReturnType<typeof createApp>>()
/** Test-only Worker. Control paths exist only in this local fixture, never the product. */
export default { async fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext) {
  const url = new URL(request.url)
  if (url.pathname.startsWith('/__test/') && request.headers.get('Authorization') === 'Bearer w29-local-control') {
    if (url.pathname === '/__test/add-entity') {
      const config = neutralConfig(true)
      await env.DB.exec(createEntity('containers', config.entities.containers).replaceAll('\n', ' '))
      await env.AUDIT_KV.put('w29-second', 'yes')
    }
    if (url.pathname === '/__test/relay') await relayAudit(env)
    if (url.pathname === '/__test/restrict') await env.DB.prepare("UPDATE memberships SET role='viewer' WHERE user_id='owner'").run()
    return Response.json({ ok: true })
  }
  const second = await env.AUDIT_KV.get('w29-second') === 'yes'
  let app = apps.get(second)
  if (!app) { app = createApp(neutralConfig(second), env); apps.set(second, app) }
  return app.fetch(request, env, ctx)
} }
