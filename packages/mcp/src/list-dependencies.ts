import { normalizeListConfig, type InstanceConfig } from '@workbasehq/core/config'

type Dependency = { entity: string; field: string; path: string; rename(to: string): void }

/** Collect operands from a fresh canonical list, never from trusted plugin objects.
 * The same references drive both dependency refusal and config-owned rewrites.
 */
export function collectListDependencies(config: InstanceConfig, entity: string, input: unknown) {
  const list = normalizeListConfig(config, entity, input)
  const dependencies: Dependency[] = []
  const value = <T, K extends keyof T>(entity: string, object: T, key: K, path: string) => {
    const field = object[key]
    if (typeof field === 'string') dependencies.push({ entity, field, path, rename: to => { object[key] = to as T[K] } })
  }
  const keys = (object: Record<string, unknown>, path: string, aliases = false) => {
    for (const field of Object.keys(object)) {
      if (aliases && Object.hasOwn(list.relatedColumns ?? {}, field)) continue
      dependencies.push({ entity, field, path: `${path}.${field}`, rename: to => {
        // Preserve configured order, including disabled hints.
        if (Object.hasOwn(object, to)) throw new Error(`Rename target already has a UI ${path} hint`)
        const entries = Object.entries(object).map(([key, hint]) => [key === field ? to : key, hint])
        for (const key of Object.keys(object)) delete object[key]
        Object.assign(object, Object.fromEntries(entries))
      } })
    }
  }
  const operand = <T, K extends keyof T>(object: T, key: K, path: string) => {
    if (!Object.hasOwn(list.relatedColumns ?? {}, String(object[key]))) value(entity, object, key, path)
  }
  list.columns?.forEach((column, i) => {
    operand(column, 'field', `columns.${i}.field`)
    operand(column, 'secondary', `columns.${i}.secondary`)
  })
  list.search?.forEach((_, i) => value(entity, list.search!, i, `search.${i}`))
  if (list.defaultSort) value(entity, list.defaultSort, 'key', 'defaultSort.key')
  if (list.filter) keys(list.filter, 'filter', true)
  if (list.sort) {
    keys(list.sort, 'sort')
    for (const [key, hint] of Object.entries(list.sort)) if (hint) hint.fields.forEach((_, i) => value(entity, hint.fields, i, `sort.${key}.fields.${i}`))
  }
  for (const [alias, related] of Object.entries(list.relatedColumns ?? {})) {
    value(entity, related, 'via', `relatedColumns.${alias}.via`)
    const target = config.entities[entity].fields[related.via]?.entity
    if (target) value(target, related, 'field', `relatedColumns.${alias}.field`)
  }
  const where = (entity: string, predicate: Record<string, unknown>, path: string) => {
    for (const [key, child] of Object.entries(predicate)) {
      const nested = `${path}.${key}`
      if (key === 'and' || key === 'or') (child as Record<string, unknown>[]).forEach((item, i) => where(entity, item, `${nested}.${i}`))
      else if (key === 'not') where(entity, child as Record<string, unknown>, nested)
      else {
        const relation = config.entities[entity].relations[key]
        if (relation) {
          if (relation.many) for (const [quantifier, item] of Object.entries(child as Record<string, Record<string, unknown>>)) where(relation.entity, item, `${nested}.${quantifier}`)
          else where(relation.entity, child as Record<string, unknown>, nested)
        } else dependencies.push({ entity, field: key, path: nested, rename: to => {
          predicate[to] = predicate[key]
          delete predicate[key]
        } })
      }
    }
  }
  list.views?.forEach((view, i) => where(entity, view.where, `views.${i}.where`))
  return { list, dependencies }
}
