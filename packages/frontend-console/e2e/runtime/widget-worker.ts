import '@workbasehq/plugins/local-auth/better-auth-als-preseed'
import { createApp, type RuntimeEnv } from '@workbasehq/core'
import { widgetDashboard } from '../../../core/test/fixtures/widget-dashboard'
let app: ReturnType<typeof createApp> | undefined
export default { fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext) {
  app ??= createApp(widgetDashboard(55), env)
  return app.fetch(request, env, ctx)
} }
