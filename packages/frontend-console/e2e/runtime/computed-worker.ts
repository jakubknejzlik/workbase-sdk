import '@workbasehq/plugins/local-auth/better-auth-als-preseed'
import { createApp, type RuntimeEnv } from '@workbasehq/core'
import { computedConfig } from './computed-config'
export default { fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext) { return createApp(computedConfig, env).fetch(request, env, ctx) } }
