import '@workbasehq/plugins/local-auth/better-auth-als-preseed'
import { createApp, type RuntimeEnv } from '@workbasehq/core'
import { neutralConfig } from './widget-labels-0.4.0-config'
const apps = new Map<boolean, ReturnType<typeof createApp>>()
/** Local compatibility fixture; the original 0.4.0 configuration stays byte-identical. */
export default { async fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext) {
  const url = new URL(request.url)
  if (url.pathname === '/__test/widget-labels/en-only' && request.headers.get('Authorization') === 'Bearer w29-local-control') {
    await env.AUDIT_KV.put('widget-labels-en-only', 'yes')
    return Response.json({ ok: true })
  }
  const englishOnly = await env.AUDIT_KV.get('widget-labels-en-only') === 'yes'
  let app = apps.get(englishOnly)
  if (!app) {
    const config = neutralConfig()
    if (englishOnly) config.enumLabels = { en: { 'Specimen count': 'Localized specimen count' } }
    app = createApp(config, env)
    apps.set(englishOnly, app)
  }
  return app.fetch(request, env, ctx)
} }
