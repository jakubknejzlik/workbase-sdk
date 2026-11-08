import '@workbasehq/plugins/local-auth/better-auth-als-preseed'
import type { RuntimeEnv, AuditOutboxRow } from '@workbasehq/core'
import { workerFetch } from '@workbasehq/core/worker-fetch'
let loader: Promise<typeof import('./worker')['default']> | undefined
const load = () => (loader ??= import('./worker').then(module => module.default))
export default {
  async queue(batch: MessageBatch<AuditOutboxRow>, env: RuntimeEnv) { await (await load()).queue(batch, env) },
  async scheduled(event: ScheduledController, env: RuntimeEnv) { await (await load()).scheduled(event, env) },
  fetch: workerFetch(load),
}
