import { eventDeliveryContext } from './event-delivery'
import { bootstrapRoutes } from './bootstrap'
import { capabilityRoutes } from './capabilities'
import { consoleModelRoutes } from './console-model'
import { queryRoutes } from './query/routes'
import { QueryError } from './query/errors'
import { validatedBrowserDispatch } from './browser-dispatch'
import { consoleRoutes } from './console'
import { openApiRoutes } from './openapi/routes'
import { jsonCookieCSRF } from './json-csrf'
import { KernelRegistry } from './kernel/registry'
import { workflowRoutes } from './workflow-routes'
import { Hono } from 'hono'
import { adminRoutes } from './admin-ui'
import { routePath } from 'hono/route'
import { ZodError } from 'zod'
import { publicSchema } from './public-schema'
import { CORE_VERSION, type InstanceInput } from './config'
import type { AppEnv, RuntimeEnv, RuntimeOptions } from './types'
import { scopeMiddleware } from './authorization'
import { crudRoutes } from './crud'
import { ApiError } from './errors'
import { identityEnvironment } from './identity-settings'
import { identityWrite } from './identity-writes'
import { securityLog } from './events'
import { ulid } from './crypto'
import { commandRoutes, createCommandRegistry } from './commands'
import { outboxStats, requireInternal } from './audit'
import { relay } from './relay'
import { schemaStatus } from './schema-compatibility'
import { opsStatus } from './ops'
import { RuleFailed } from './execution/errors'
import { timeRequest, timedSync, timedDatabase } from './request-timing'
export function createApp(input: InstanceInput, env: RuntimeEnv, options: RuntimeOptions = {}) {
  return timedSync('bootstrap', () => buildApp(input, env, options))
}
function buildApp(input: InstanceInput, env: RuntimeEnv, options: RuntimeOptions) {
  env = { ...env, DB: timedDatabase(env.DB) }
  if (options.authorization === 'trust' && (env.SCHEMA_EXPECTED || (env.STAGE && env.STAGE !== 'local'))) throw new Error('authorization_trust_requires_development')
  const kernel = new KernelRegistry(input, options, env)
  const config = kernel.config
  options = { ...options, commands: kernel.commands, workflows: kernel.workflows }
  env = identityEnvironment(env)
  const app = new Hono<AppEnv>()
  const fetch = app.fetch.bind(app)
  app.fetch = (request, bindings, context) => timeRequest(async () => await fetch(request, bindings, context))
  app.use('*', async (c, next) => {
    let context: Pick<ExecutionContext, 'waitUntil'> | undefined
    try { context = c.executionCtx } catch { /* app.request() has no Worker context. */ }
    return context ? eventDeliveryContext.run({ waitUntil: promise => context!.waitUntil(promise) }, next) : next()
  })
  app.use('*', async (c, next) => {
    const url = new URL(c.req.url)
    // Keep the native endpoint registered, with one canonical browser/cookie origin.
    if (env.STAGE === 'staging' && url.hostname.endsWith('.workers.dev') && env.AUTH_BASE_URL) {
      const target = new URL(env.AUTH_BASE_URL)
      target.pathname = url.pathname; target.search = url.search
      return c.redirect(target.href, 308)
    }
    await next()
  })
  app.use('*', async (c, next) => {
    const correlation = c.req.header('X-Correlation-Id')
    c.set('correlationId', correlation && /^[a-zA-Z0-9_-]{1,100}$/.test(correlation) ? correlation : ulid())
    await next()
    c.header('X-Correlation-Id', c.get('correlationId'))
  })
  app.onError(async (error, c) => {
    const known = error instanceof ApiError
    const constraint = /SQLITE_CONSTRAINT|constraint failed/i.test(error.message)
    const status = known ? error.status : error instanceof ZodError || error instanceof SyntaxError ? 400 : constraint ? 409 : 500
    if (known && error.code === 'insecure_identity_transport') {
      // Fixed code only: callbacks and magic-link URLs contain credentials.
      await identityWrite(env, config, 'security_denied', [{
        sql: 'INSERT INTO security_log (id,operation,status,correlation_id,occurred_at) VALUES (?,?,?,?,?)',
        bindings: [ulid(), error.code, status, c.get('correlationId'), new Date().toISOString()], expectRows: 1,
      }])
    } else if (status === 403 || status === 409) {
      if (c.req.path.startsWith('/auth/') && c.req.path !== '/auth/register') await identityWrite(env, config, 'security_denied', [{
        sql: 'INSERT INTO security_log (id,operation,status,correlation_id,occurred_at) VALUES (?,?,?,?,?)',
        bindings: [ulid(), `${c.req.method} ${routePath(c, -1)}`, status, c.get('correlationId'), new Date().toISOString()], expectRows: 1,
      }])
      else await securityLog(env.DB, { ...c.get('scope'), correlationId: c.get('correlationId') }, `${c.req.method} ${routePath(c, -1)}`, status)
    }
    return c.json({ error: known ? error.code : status === 400 ? 'validation_error' : constraint ? 'constraint_conflict' : 'internal_error', ...(error instanceof ZodError && c.req.path.startsWith('/api/') ? { issues: error.issues.map(({ path, code }) => ({ path, code })) } : {}), ...(error instanceof QueryError ? { path: error.path, ...(error.cost ? { cost: error.cost } : {}) } : {}), ...(known && error.hint ? { hint: error.hint } : {}), ...(known && error.detail ? { detail: error.detail } : {}), ...(error instanceof RuleFailed && error.code === 'rule_failed' ? { rule: error.rule, diagnosis: error.diagnosis } : {}) }, status as any)
  })
  app.get('/health', async c => {
    const schema = await schemaStatus(env, config)
    return c.json({ instance: config.id, revision: config.revision, core_version: CORE_VERSION, schema }, schema.compatible ? 200 : 503)
  })
  // Public build metadata only: never include runtime bindings, credentials or records.
  app.get('/console-info', c => c.json({ instance: config.id, displayName: config.displayName, roles: config.roles, locale: config.locale, ui: { defaultLanguage: config.ui?.defaultLanguage } }))
  app.get('/schema', c => c.json(publicSchema(config, options)))
  openApiRoutes(app, config)
  consoleRoutes(app, config, env)
  for (const path of ['/api/*', '/commands/*', '/workflows/*', '/query', '/orgs', '/orgs/*', '/organizations/*', '/me/profile', '/invitations/*']) app.use(path, jsonCookieCSRF(env))
  adminRoutes(validatedBrowserDispatch(app, env), config, env, options.commands, options.workflows)
  // Native admin forms have already passed adminForm; JSON identity mutations use the same provenance gate.
  app.use('/auth/*', jsonCookieCSRF(env))
  app.use('/internal/*', async (c, next) => { requireInternal(env, c.req.header('X-Internal-Token')); await next() })
  app.post('/internal/relay', async c => c.json(await relay(env, config)))
  app.get('/internal/ops', async c => c.json(await opsStatus(env, config)))
  app.get('/internal/outbox-stats', async c => c.json(await outboxStats(env.DB)))
  app.get('/internal/webhook-failures', async c => {
    const result = await env.DB.prepare("SELECT event_id,organization_id,attempts,next_attempt_at,last_error FROM webhook_deliveries WHERE state='failed' ORDER BY next_attempt_at LIMIT 100").all()
    return c.json({ data: result.results })
  })
  for (const path of ['/api/*', '/commands/*', '/query']) app.use(path, scopeMiddleware(env, config, kernel))
  workflowRoutes(app, config, env, options.workflows ?? new Map())
  kernel.mount(app, env)
  options.extend?.(app, config, env)
  bootstrapRoutes(app, kernel, env, options)
  capabilityRoutes(app, kernel, env)
  consoleModelRoutes(app, kernel, env)
  queryRoutes(app, kernel, env)
  crudRoutes(app, config, env)
  commandRoutes(app, config, env, options.commands ?? createCommandRegistry([]))
  app.all('/commands/*', () => { throw new ApiError(405, 'unsupported_command') })
  return app
}
