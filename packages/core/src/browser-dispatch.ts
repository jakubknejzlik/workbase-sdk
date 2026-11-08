import type { App, RuntimeEnv } from './types'
/** A private adapter object, never a network header or alternate public entry point.
 * The frozen admin's internal JSON calls occur after adminForm validates its HMAC/provenance.
 * Keep native form compatibility while requiring full provenance at the JSON boundary.
 */
export function validatedBrowserDispatch(app: App, env: RuntimeEnv): App {
  const adapter = Object.create(app) as App
  adapter.fetch = (request, ...args) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const headers = new Headers(request.headers)
      headers.set('Origin', env.IDENTITY?.baseURL ?? env.AUTH_BASE_URL ?? new URL(request.url).origin)
      headers.set('Sec-Fetch-Site', 'same-origin')
      headers.set('Content-Type', 'application/json')
      request = new Request(request, { headers })
    }
    return app.fetch(request, ...args)
  }
  return adapter
}
