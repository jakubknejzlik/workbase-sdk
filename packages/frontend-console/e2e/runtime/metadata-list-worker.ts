import '@workbasehq/plugins/local-auth/better-auth-als-preseed'
import { createApp, type RuntimeEnv } from '@workbasehq/core'
import { listV2Config } from './list-v2-config'

// Reuse the existing synthetic schema, grants and seed; vary presentation only.
const config = { ...listV2Config, languages: ['en', 'cs'], timeZone: 'Europe/Prague', ui: {
  ...listV2Config.ui, entities: { ...listV2Config.ui?.entities, worker: { ...listV2Config.ui?.entities?.worker, list: {
    ...listV2Config.ui?.entities?.worker?.list, mobileCards: true,
    columns: [{ field: 'name' }, { field: 'id', cell: { kind: 'identifier' as const, copy: true } }, { field: 'updated_at', cell: { kind: 'datetime' as const } }],
  } } },
} }
let app: ReturnType<typeof createApp> | undefined
export default { fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext) {
  app ??= createApp(config, env)
  return app.fetch(request, env, ctx)
} }
