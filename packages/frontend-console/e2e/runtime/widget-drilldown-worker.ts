import '@workbasehq/plugins/local-auth/better-auth-als-preseed'
import { createApp, type RuntimeEnv } from '@workbasehq/core'
import { widgetDrilldownConfig } from './widget-drilldown-config'
let app: ReturnType<typeof createApp> | undefined
export default { async fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext) {
  // Local fixture control changes real membership authority; no product endpoint.
  const url = new URL(request.url)
  if (url.pathname === '/__test/restrict' && request.headers.get('Authorization') === 'Bearer w29-local-control') {
    await env.DB.prepare("UPDATE memberships SET role='viewer' WHERE user_id='owner'").run()
    return Response.json({ ok: true })
  }
  app ??= createApp(widgetDrilldownConfig, env)
  return app.fetch(request, env, ctx)
} }
