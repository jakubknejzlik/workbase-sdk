import '@workbasehq/plugins/local-auth/better-auth-als-preseed'
import { createApp, type RuntimeEnv } from '@workbasehq/core'
import { detailInformationConfig } from './detail-information-config'

let app: ReturnType<typeof createApp> | undefined
export default { fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext) {
  app ??= createApp(detailInformationConfig, env)
  return app.fetch(request, env, ctx)
} }
