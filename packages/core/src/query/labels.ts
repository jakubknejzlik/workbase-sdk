import { readableComputed, expressionInfo } from './expressions'
import { Q, walk, type ISequelizable } from '@jakub.knejzlik/ts-query'
import type { InstanceConfig } from '../config'
import type { KernelRegistry } from '../kernel/registry'
import type { Scope } from '../types'

/** Only configured to-one paths are accepted; callers cannot name arbitrary joins. */
export function labelPath(config: InstanceConfig, entity: string, key: string) {
  const related = config.ui?.entities?.[entity]?.list?.relatedColumns?.[key]
  let source = entity
  const hops: { source: string; field: string; target: string }[] = []
  for (const field of related ? [related.via, related.field] : [key]) {
    const spec = config.entities[source]?.fields[field]
    if (spec?.type !== 'ref' || !spec.entity) return undefined
    hops.push({ source, field, target: spec.entity }); source = spec.entity
  }
  return { hops, entity: source, display: config.entities[source].displayField }
}
export function readableLabel(kernel: KernelRegistry, scope: Scope, entity: string, key: string) {
  const path = labelPath(kernel.config, entity, key)
  if (!path || path.hops.some(hop => !kernel.fieldMask(hop.source, scope).includes(hop.field) || !kernel.can(scope, hop.target, 'read') || !kernel.fieldMask(hop.target, scope).includes('id'))) return undefined
  // Masked display fields produce Record, with a null sorting key.
  return { ...path, display: readableDisplay(kernel, scope, path.entity) }
}
export const labelAlias = (key: string) => `__label_${key}`
export const sortAlias = (key: string) => `__sort_${key}`

/** Discover column operands through ts-query's visitor, including operands in Fn.if.
 * Dotted operands are configured to-one FK paths, ending in a real field. A target's
 * displayField expands its entity label in that target's own scoped source.
 */
const columnCache = new WeakMap<ISequelizable, string[]>()
export function expressionColumns(expression: ISequelizable): string[] {
  const cached = columnCache.get(expression)
  if (cached) return cached
  const columns = new Set<string>()
  walk(Q.select().field(expression as ReturnType<typeof Q.raw>), {
    onColumn: (table, name) => { columns.add(table ? `${table}.${name}` : name) },
    onRaw: () => { throw new Error('Display labels require structured ts-query expressions, not raw SQL') },
    onSubquery: depth => { if (depth) throw new Error('Display labels use ref paths, not subqueries') },
  })
  const result = [...columns]
  columnCache.set(expression, result)
  return result
}
export function expressionPath(config: Pick<InstanceConfig, 'entities'>, entity: string, column: string) {
  const parts = column.split('.')
  const field = parts.pop()!
  const hops: { source: string; field: string; target: string }[] = []
  for (const key of parts) {
    const spec = config.entities[entity]?.fields[key]
    if (spec?.type !== 'ref' || !spec.entity) throw new Error(`Invalid label reference: ${entity}.${column}`)
    hops.push({ source: entity, field: key, target: spec.entity }); entity = spec.entity
  }
  if (!['id', 'organization_id', 'created_at', 'updated_at', 'version'].includes(field) && !Object.hasOwn(config.entities[entity].fields, field)) throw new Error(`Unknown label field: ${entity}.${field}`)
  return { hops, entity, field }
}
export function validateLabelExpressions(config: InstanceConfig) {
  function visit(entity: string, stack: string[]) {
    const spec = config.entities[entity]
    if (!spec.label) return
    if (!spec.displayField || spec.fields[spec.displayField]?.type !== 'string' || !spec.fields[spec.displayField]?.readOnly) throw new Error(`Label requires a read-only string displayField: ${entity}`)
    if (stack.includes(entity)) throw new Error(`Cyclic display label: ${[...stack, entity].join(' -> ')}`)
    for (const column of expressionColumns(spec.label)) {
      const path = expressionPath(config, entity, column)
      if (path.field === config.entities[path.entity].displayField) visit(path.entity, [...stack, entity])
    }
  }
  for (const entity of Object.keys(config.entities)) visit(entity, [])
}

/** A label is readable only when every dependency is readable. Never use a persisted
 * value as a fallback when a dependency is masked. Runtime row scopes still apply.
 */
export function readableDisplay(kernel: KernelRegistry, scope: Scope, entity: string): string | undefined {
  const spec = kernel.config.entities[entity]
  if (!spec.displayField || !kernel.fieldMask(entity, scope).includes(spec.displayField) || spec.fields[spec.displayField]?.computed && !readableComputed(kernel, scope, entity, spec.displayField)) return undefined
  if (spec.label && expressionColumns(spec.label).some(column => {
    const path = expressionPath(kernel.config, entity, column)
    return path.hops.some(hop => !kernel.fieldMask(hop.source, scope).includes(hop.field) || !kernel.can(scope, hop.target, 'read') || !kernel.fieldMask(hop.target, scope).includes('id'))
      || !kernel.fieldMask(path.entity, scope).includes(path.field)
      || (path.field === kernel.config.entities[path.entity].displayField && !readableDisplay(kernel, scope, path.entity))
  })) return undefined
  return spec.displayField
}

/** Browser dependency metadata contains field names only; execution stays server-side. */
export function labelDependencies(config: Pick<InstanceConfig, 'entities'>, entity: string): { entity: string; field: string }[] {
  const result = new Map<string, { entity: string; field: string }>()
  function visit(name: string) {
    const definition = config.entities[name]
    const computed = definition.displayField && definition.fields[definition.displayField]?.computed
    if (!definition.label && !computed) return
    if (computed) {
      for (const dep of expressionInfo(config, name, definition.displayField!, computed).dependencies) {
        const items = [...dep.hops.flatMap(hop => [{ entity: hop.source, field: hop.field }, { entity: hop.target, field: 'id' }]), { entity: dep.entity, field: dep.field }]
        for (const item of items) result.set(`${item.entity}.${item.field}`, item)
      }
      return
    }
    for (const column of expressionColumns(definition.label!)) {
      const path = expressionPath(config, name, column)
      for (const hop of path.hops) for (const dependency of [{ entity: hop.source, field: hop.field }, { entity: hop.target, field: 'id' }]) result.set(`${dependency.entity}.${dependency.field}`, dependency)
      const dependency = { entity: path.entity, field: path.field }
      const key = `${dependency.entity}.${dependency.field}`
      if (!result.has(key)) {
        result.set(key, dependency)
        if (path.field === config.entities[path.entity].displayField) visit(path.entity)
      }
    }
  }
  visit(entity)
  return [...result.values()]
}
