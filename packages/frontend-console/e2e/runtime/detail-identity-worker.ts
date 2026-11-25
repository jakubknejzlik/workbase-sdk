import '@workbasehq/plugins/local-auth/better-auth-als-preseed'
import { createApp, type RuntimeEnv } from '@workbasehq/core'
import { listV2Config } from './list-v2-config'

// Existing neutral schema/grants/seed, with a declared related-list shape for
// whole-page C1 acceptance. No consumer configuration or new presentation API.
const config = { ...listV2Config, languages: ['en', 'cs'], timeZone: 'Europe/Prague', ui: {
  ...listV2Config.ui, entities: { ...listV2Config.ui?.entities, team: { detail: { lists: {
    workers: { entity: 'worker', label: 'Related workers', bind: { field: 'team_id', record: 'id' as const }, columns: ['name', 'status'] },
  } } } },
} }
let app: ReturnType<typeof createApp> | undefined
export default { fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext) {
  app ??= createApp(config, env)
  return app.fetch(request, env, ctx)
} }
