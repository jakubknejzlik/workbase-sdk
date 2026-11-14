import { canonical } from '../canonical'
import type { InstanceConfig } from '../config'
import type { App } from '../types'

function validSpec(spec: unknown, revision: number): spec is Record<string, unknown> {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return false
  const value = spec as Record<string, unknown>
  const info = value.info as { version?: unknown } | undefined
  return value.openapi === '3.1.0' && info?.version === `r${revision}`
    && value['x-workbase-revision'] === revision
    && typeof value['x-workbase-config-hash'] === 'string' && /^[a-f0-9]{64}$/.test(value['x-workbase-config-hash'])
    && !!value.paths && typeof value.paths === 'object' && !Array.isArray(value.paths)
    && !!value.components && typeof value.components === 'object' && !Array.isArray(value.components)
}

/** Generated public artifact, carried as data across module realms and bundles. */
export function bindOpenApi<T extends InstanceConfig>(config: T, spec: unknown): T {
  if (config.baseline !== 'workbase-sdk' || !validSpec(spec, config.revision)) throw new Error('Invalid openapi.json binding')
  config.openapi = JSON.parse(JSON.stringify(canonical(spec)))
  return config
}

/** Public, independent of identity, database contents and ASSETS. */
export function openApiRoutes(app: App, config: InstanceConfig): void {
  const bytes = validSpec(config.openapi, config.revision) ? JSON.stringify(canonical(config.openapi), null, 2) + '\n' : undefined
  app.get('/openapi.json', c => bytes === undefined
    ? c.json({ error: 'openapi_not_bound' }, 503)
    : c.body(bytes, 200, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' }))
}
