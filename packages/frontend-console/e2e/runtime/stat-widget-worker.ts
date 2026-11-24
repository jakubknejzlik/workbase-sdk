import '@workbasehq/plugins/local-auth/better-auth-als-preseed'
import { createApp, type RuntimeEnv } from '@workbasehq/core'
import { neutralConfig } from './config'

const config = neutralConfig()
const dashboard = config.plugins!.find(plugin => plugin.name === 'neutral-dashboard')!
dashboard.contributes!.console!.pages = [{ id: 'neutral.summary', path: '/summary', label: 'Summary',
  sections: [{ row: ['zero', 'nonzero', 'missing'] }], widgets: [
    { id: 'zero', label: 'Zero', kind: 'stat', query: { entity: 'specimens', where: { name: { eq: 'Missing Example' } } }, aggregate: { fn: 'count' } },
    { id: 'nonzero', label: 'Nonzero', kind: 'stat', query: { entity: 'specimens' }, aggregate: { fn: 'count' } },
    { id: 'missing', label: 'Missing', kind: 'stat', query: { entity: 'specimens', where: { name: { eq: 'Missing Example' } } }, aggregate: { fn: 'sum', field: 'quantity' } },
  ],
}]
let app: ReturnType<typeof createApp> | undefined
export default { fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext) {
  app ??= createApp(config, env)
  return app.fetch(request, env, ctx)
} }
