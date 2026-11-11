import '@workbasehq/plugins/local-auth/better-auth-als-preseed'
import { createApp, type RuntimeEnv } from '@workbasehq/core'
import { rowConfig } from './row-invitations-config'
let app: ReturnType<typeof createApp> | undefined
export default { async fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext) {
  if (new URL(request.url).pathname === '/__test/expire' && request.headers.get('Authorization') === 'Bearer row-local-control') {
    await env.DB.prepare("UPDATE invitations SET expires_at='2000-01-08',created_at='2000-01-01' WHERE accepted_at IS NULL").run()
    return Response.json({ ok: true })
  }
  app ??= createApp(rowConfig, env)
  return app.fetch(request, env, ctx)
} }
