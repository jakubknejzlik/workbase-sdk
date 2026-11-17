import '@workbasehq/plugins/local-auth/better-auth-als-preseed'
import { createApp, type RuntimeEnv } from '@workbasehq/core'
import { applicationAccessConfig } from './application-access-config'
let app: ReturnType<typeof createApp> | undefined
export default { fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext) {
  app ??= createApp(applicationAccessConfig, env)
  return app.fetch(request, env, ctx)
} }
