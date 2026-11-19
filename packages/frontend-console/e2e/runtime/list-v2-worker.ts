import '@workbasehq/plugins/local-auth/better-auth-als-preseed'
import { createApp, type RuntimeEnv } from '@workbasehq/core'
import { listV2Config } from './list-v2-config'
let app: ReturnType<typeof createApp> | undefined
export default { fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext) {
  app ??= createApp(listV2Config, env)
  return app.fetch(request, env, ctx)
} }
