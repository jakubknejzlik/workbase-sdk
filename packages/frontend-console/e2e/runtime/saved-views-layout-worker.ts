import '@workbasehq/plugins/local-auth/better-auth-als-preseed'
import { createApp, type RuntimeEnv } from '@workbasehq/core'
import { applicationAccessConfig as config } from './application-access-config'

// Exercise wrapping in the real shell using ordinary authored navigation labels.
config.ui = { entities: {}, ...config.ui, navigation: {
  groups: [{ id: 'records', label: 'Synthetic saved view navigation' }],
  items: [{ id: 'worker', entity: 'worker', group: 'records', label: 'Synthetic collection records' }],
} }
let app: ReturnType<typeof createApp> | undefined
export default { fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext) {
  app ??= createApp(config, env)
  return app.fetch(request, env, ctx)
} }
