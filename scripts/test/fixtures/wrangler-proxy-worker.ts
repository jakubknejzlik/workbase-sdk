import { createApp, type RuntimeEnv } from '../../../packages/core/src'
import { listV2Config } from '../../../packages/frontend-console/e2e/runtime/list-v2-config'

let entries = 0
let app: ReturnType<typeof createApp> | undefined
export default {
  fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === '/__contract/entries') return Response.json({ entries })
    app ??= createApp(listV2Config, env, { extend(app) {
      app.get('/__contract/sdk500', () => { entries++; throw new Error('synthetic SDK failure') })
    } })
    return app.fetch(request, env, ctx)
  },
}
