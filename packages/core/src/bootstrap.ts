import type { App, RuntimeEnv, RuntimeOptions } from './types'
import type { KernelRegistry } from './kernel/registry'
import { capabilities } from './capabilities'
import { publicSchema } from './public-schema'
import { meDocument } from './organizations'
import { scopeMiddleware } from './authorization'
import { buildInfo } from './console'

/** Session-local QueryClient caching only: never share actor/org projections in HTTP caches. */
export function bootstrapRoutes(app: App, kernel: KernelRegistry, env: RuntimeEnv, options: RuntimeOptions) {
  app.get('/o/:org/bootstrap', scopeMiddleware(env, kernel.config, kernel), async c => c.json({
    schema: publicSchema(kernel.config, options),
    capabilities: capabilities(kernel, c.get('scope')),
    console: kernel.providers.get('console')?.[0]?.consoleRegistry?.(kernel.config, c.get('scope')),
    me: meDocument(c.get('resolvedActor'), kernel.config),
    build: await buildInfo(kernel.config, env, c.req.url),
  }, 200, { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization, X-Organization-Id' }))
  app.get('/bootstrap', async c => c.json({
    schema: publicSchema(kernel.config, options),
    me: meDocument(await kernel.requireActor(c.req.raw, env), kernel.config),
    build: await buildInfo(kernel.config, env, c.req.url),
  }, 200, { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization' }))
}
