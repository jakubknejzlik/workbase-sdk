import '@workbasehq/plugins/local-auth/better-auth-als-preseed'
import { createApp, scheduledRelay, consumeEvents, type AuditOutboxRow, type RuntimeEnv } from '@workbasehq/core'
import { workerFetch } from '@workbasehq/core/worker-fetch'
import { sample } from './model'
const apps = new WeakMap<RuntimeEnv, ReturnType<typeof createApp>>()
const appFor = (env: RuntimeEnv) => {
  let app = apps.get(env)
  if (!app) { app = createApp(sample, env); apps.set(env, app) }
  return app
}
const worker = {
  queue: (batch: MessageBatch<AuditOutboxRow>, env: RuntimeEnv) => consumeEvents(batch, env, sample),
  scheduled: (event: ScheduledController, env: RuntimeEnv) => scheduledRelay(event, env, { config: sample }),
  fetch: (request: Request, env: RuntimeEnv, ctx?: ExecutionContext) => appFor(env).fetch(request, env, ctx),
}
export default { ...worker, fetch: workerFetch(async () => worker) }
