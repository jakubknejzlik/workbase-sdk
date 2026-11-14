import type { App, AppContext, RuntimeEnv } from './types'
import type { InstanceConfig } from './config'

export const CONSOLE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
export async function buildInfo(config: Pick<InstanceConfig, 'revision'>, env: RuntimeEnv, url: string) {
  let sha = env.BUILD_SHA; let builtAt = env.BUILD_AT
  // Raw local `wrangler dev --local` has the build manifest even without SST's bindings.
  if ((!sha || !builtAt) && env.ASSETS) {
    const response = await env.ASSETS.fetch(new Request(new URL('/build-meta.json', url)))
    if (response.ok) {
      const build = await response.json() as { sha?: unknown; builtAt?: unknown }
      if (typeof build.sha === 'string' && /^[a-f0-9]{40}$/.test(build.sha) && typeof build.builtAt === 'string' && Number.isFinite(Date.parse(build.builtAt))) {
        sha = build.sha; builtAt = build.builtAt
      }
    }
  }
  return { sha: sha ?? 'unbuilt', builtAt: builtAt ?? 'unbuilt', revision: config.revision, openapi: env.OPENAPI_SHA256 ?? 'unbuilt' }
}
function isConsolePath(path: string) {
  return !(/^\/(api|auth|mcp|internal|ops|admin|commands|workflows|query|orgs|invitations|audit|me|health|schema|console-info|bootstrap|build\.json|openapi\.json)(\/|$)/.test(path)
    || /^\/o\/[^/]+\/(bootstrap|capabilities|console-model|console-registry|console-pages|config-versions)(\/|$)/.test(path))
}

async function serveConsole(request: Request, env: RuntimeEnv) {
  if (!env.ASSETS) return Response.json({ error: 'console_not_built' }, { status: 503, headers: { 'Content-Security-Policy': CONSOLE_CSP } })
  const url = new URL(request.url)
  let response = await env.ASSETS.fetch(request)
  if (response.status === 404 && !url.pathname.split('/').at(-1)?.includes('.')) {
    url.pathname = '/index.html'
    response = await env.ASSETS.fetch(new Request(url, request))
  }
  const headers = new Headers(response.headers)
  headers.set('Content-Security-Policy', CONSOLE_CSP)
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Referrer-Policy', 'no-referrer')
  if (headers.get('Content-Type')?.includes('text/html')) headers.set('Cache-Control', 'no-cache')
  return new Response(response.body, { status: response.status, headers })
}

/** Safe before loading the application: public assets/build contain no actor projections. */
export async function publicConsoleResponse(request: Request, env: RuntimeEnv): Promise<Response | undefined> {
  const url = new URL(request.url)
  if (env.STAGE === 'staging' && url.hostname.endsWith('.workers.dev') && env.AUTH_BASE_URL) {
    const target = new URL(env.AUTH_BASE_URL)
    target.pathname = url.pathname; target.search = url.search
    return Response.redirect(target.href, 308)
  }
  if (!['GET', 'HEAD'].includes(request.method)) return
  const path = url.pathname
  if (path === '/build.json' && env.SCHEMA_EXPECTED) {
    let revision: unknown
    try { revision = JSON.parse(env.SCHEMA_EXPECTED).revision } catch { return }
    if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) return
    const response = Response.json(await buildInfo({ revision }, env, request.url), { headers: { 'Cache-Control': 'no-store' } })
    return request.method === 'HEAD' ? new Response(null, response) : response
  }
  if (path === '/console' || path.startsWith('/console/')) {
    const target = (path.slice('/console'.length) || '/') + url.search
    return new Response(null, { status: 301, headers: { Location: target.startsWith('//') ? url.origin + target : target } })
  }
  if (path === '/auth/complete' || isConsolePath(path)) return serveConsole(request, env)
}
/** Same-origin assets are always reached through the Worker, including navigations. */
export function consoleRoutes(app: App, config: InstanceConfig, env: RuntimeEnv) {
  for (const path of ['/console', '/console/*']) app.all(path, c => {
    const url = new URL(c.req.url)
    const target = (url.pathname.slice('/console'.length) || '/') + url.search
    // A doubled slash in an old path must never become a cross-origin redirect.
    return c.redirect(target.startsWith('//') ? url.origin + target : target, 301)
  })
  app.get('/build.json', async c => {
    return c.json(await buildInfo(config, env, c.req.url), 200, { 'Cache-Control': 'no-store' })
  })
  const serve = (c: AppContext) => serveConsole(c.req.raw, env)
  // This exact browser callback precedes /auth/* and never reaches Better Auth.
  app.get('/auth/complete', serve)
  app.notFound(c => {
    const path = c.req.path
    // Reserve service namespaces, including unknown endpoints, before the SPA.
    if (!['GET', 'HEAD'].includes(c.req.method)
      || !isConsolePath(path)) return c.text('404 Not Found', 404)
    return serve(c)
  })
}
