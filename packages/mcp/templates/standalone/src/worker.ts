import { createApp, scheduledRelay, consumeEvents, type AuditOutboxRow, type RuntimeEnv } from '@workbasehq/core'
import config from '../config'
const apps = new WeakMap<RuntimeEnv, ReturnType<typeof createApp>>()
function appFor(env: RuntimeEnv) {
  let app = apps.get(env)
  if (!app) { app = createApp(config, env); apps.set(env, app) }
  return app
}
export default {
  queue: (batch: MessageBatch<AuditOutboxRow>, env: RuntimeEnv) => consumeEvents(batch, env, config),
  scheduled: async (_event: ScheduledController, env: RuntimeEnv) => { await scheduledRelay(_event, env, { config }) },
  fetch: (request: Request, env: RuntimeEnv, ctx?: ExecutionContext) => appFor(env).fetch(request, env, ctx),
}
