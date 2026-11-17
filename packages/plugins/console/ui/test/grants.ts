import type { Capabilities } from '../src/gate'
/** Synthetic server projections for the pre-capability renderer regressions. */
export function grants(entities: Record<string, { fields: Record<string, unknown> }>): Capabilities {
  return { revision: 1, organization: { role: 'admin' }, commands: [], workflows: {}, resources: {}, entities: Object.fromEntries(Object.entries(entities).map(([entity, meta]) => [entity, { readable: ['id', 'version', ...Object.keys(meta.fields)], writable: Object.keys(meta.fields), operations: ['read', 'create', 'update'] }])) }
}
