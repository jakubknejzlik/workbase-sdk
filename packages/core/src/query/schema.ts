import { organizationPermission } from '../organization-permissions'
import { userLinks } from '../user-link-fields'
import { baseFields } from '../model-inputs'
import type { KernelRegistry } from '../kernel/registry'
import type { Scope } from '../types'
import { invalid, QueryError, type QueryPath } from './errors'
import { QUERY_LIMITS as L, type QueryCost } from './limits'
import { isRestQuery } from './facade'
import { labelPath } from './labels'
import { expressionInfo, fieldExpression, readableComputed } from './expressions'

export { fieldsFor, fieldType, operatorsFor, filterSchema, querySchema } from './input-schema'
export type { Scalar, Filter, Order, Selection, RowAccessState, QueryInput } from './input-schema'
import { fieldsFor, operatorsFor, querySchema, type Filter, type Selection, type QueryInput } from './input-schema'
/** Bound recursion before Zod, including malformed/unrecognized inputs. */
function preflight(input: unknown) {
  let nodes = 0
  function visit(value: unknown, depth: number) {
    if (++nodes > L.nodes || depth > L.filterDepth * 3) throw new QueryError('query_too_expensive', [], { depth, nodes, relations: 0, exists: 0, fieldRows: 0 })
    if (value && typeof value === 'object') {
      if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid()
      for (const [key, child] of Object.entries(value)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) invalid(['?'])
        visit(child, depth + 1)
      }
    }
  }
  visit(input, 0)
}
export function validateQuery(kernel: KernelRegistry, scope: Scope, input: unknown, legacyErrors = false): { query: QueryInput; cost: QueryCost } {
  preflight(input)
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid()
  const entity = (input as QueryInput).entity
  if (typeof entity !== 'string' || !Object.hasOwn(kernel.config.entities, entity)) throw new QueryError('entity_not_found', ['entity'])
  const depthCost: QueryCost = { depth: 0, relations: 0, fieldRows: 0, exists: 0, nodes: 0 }
  function relationDepth(name: string, node: unknown, depth: number, path: QueryPath) {
    depthCost.nodes++; depthCost.depth = Math.max(depthCost.depth, depth)
    if (depth > L.relationDepth) throw new QueryError('query_too_expensive', path, depthCost)
    if (!node || typeof node !== 'object') return
    for (const [key, child] of Object.entries(node)) {
      if (Object.hasOwn(kernel.config.entities[name].relations, key)) {
        const r = kernel.config.entities[name].relations[key]; depthCost.relations++
        relationDepth(r.entity, child, depth + 1, [...path, key])
      } else if (['where', 'include', 'and', 'or', 'not', 'some', 'none'].includes(key)) {
        if (Array.isArray(child)) child.forEach((item, i) => relationDepth(name, item, depth, [...path, key, i]))
        else relationDepth(name, child, depth, [...path, key])
      }
    }
  }
  relationDepth(entity, input, 0, [])
  const parsed = querySchema(kernel.config, entity, isRestQuery(input)).safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    // Unknown client keys/values never become error text or paths.
    const known = new Set(['entity', 'rowAccess', 'select', 'where', 'search', 'text', 'fields', 'locale', 'labelWhere', 'labels', 'label', 'orderBy', 'field', 'dir', 'limit', 'cursor', 'include', 'and', 'or', 'not', 'some', 'none',
      ...Object.values(kernel.config.entities).flatMap(e => [...Object.keys(e.fields), ...Object.keys(e.relations)]), ...baseFields,
      ...operatorsFor('string')])
    invalid(issue.path.map(p => typeof p === 'number' ? p : known.has(String(p)) ? String(p) : '?'))
  }
  const query = parsed.data as QueryInput
  if (query.rowAccess) {
    if (!kernel.providers.has('members') || !userLinks(kernel.config).some(link => link.entity === entity)) invalid(['rowAccess'])
    kernel.resourcePermission(scope, 'invitations.read')
    organizationPermission(kernel.config, scope, 'invitations.read')
    kernel.readPermission(scope, entity)
  }
  if (query.contextList) {
    const context = query.contextList
    // Resolve from trusted configuration using the same plugin-over-model precedence as the registry.
    let detail = kernel.config.ui?.entities?.[context.entity]?.detail
    for (const plugin of kernel.config.plugins ?? []) detail = plugin.contributes?.console?.entities?.[context.entity]?.detail ?? detail
    const list = detail?.lists?.[context.list]
    if (!list || !Object.hasOwn(detail!.lists!, context.list) || list.entity !== entity || query.include && Object.keys(query.include).length) throw new QueryError('query_invalid', ['contextList'])
    try { kernel.readPermission(scope, context.entity) } catch { throw new QueryError('field_forbidden', ['contextList']) }
    if (!kernel.fieldMask(context.entity, scope).includes('id')) throw new QueryError('field_forbidden', ['contextList'])
    const locked = { [list.bind.field]: { eq: context.id } }
    query.where = query.where ? { and: [locked, query.where] } : locked
    // This predicate goes through normal field masks, policy-scoped sources and cursor hashing.
    delete query.contextList
  }
  const cost: QueryCost = { depth: 0, relations: 0, fieldRows: 0, exists: query.rowAccess ? 2 : 0, nodes: 0 }
  // Every compiled client table source masks each readable FK once. Visibility
  // probes only test the target's scoped predicate, so do not recursively mask it.
  function foreignKeyCost(name: string) {
    cost.exists += kernel.fieldMask(name, scope).filter(field => kernel.config.entities[name].fields[field]?.type === 'ref').length
  }
  // Charge expanded sources per evaluation context, including transitive computed fields.
  // A repeated table alias counts again even when it names the same schema entity.
  const expressionContexts = new Map<string, Set<string>>()
  function expressionCost(name: string, field: string, context: string, rows: number, stack = new Set<string>()) {
    const key = `${name}.${field}`
    const seen = expressionContexts.get(context) ?? new Set<string>(); expressionContexts.set(context, seen)
    if (seen.has(key) || stack.has(key) || !readableComputed(kernel, scope, name, field)) return
    seen.add(key)
    const wire = fieldExpression(kernel.config, name, field); if (!wire) return
    const info = expressionInfo(kernel.config, name, field, wire)
    const hopSources = new Set<string>()
    for (const dep of info.dependencies) {
      let sourcePath = dep.sourcePath ?? ''
      for (const hop of dep.hops) { sourcePath += `/${hop.field}`; hopSources.add(sourcePath) }
    }
    const sources = info.sources.length + hopSources.size
    cost.expressionSources = (cost.expressionSources ?? 0) + sources
    cost.relations += sources; cost.nodes += info.nodes; cost.fieldRows += rows * sources
    for (const source of info.sources) foreignKeyCost(source)
    const next = new Set(stack).add(key)
    for (const dep of info.dependencies) {
      let dependencyContext = dep.sourcePath ? `${context}/${key}/source/${dep.sourcePath}` : context
      for (const hop of dep.hops) {
        expressionCost(hop.source, hop.field, dependencyContext, rows, next)
        dependencyContext += `/ref/${hop.field}`
      }
      expressionCost(dep.entity, dep.field, dependencyContext, rows, next)
    }
  }
  function readable(name: string, field: string, path: QueryPath) {
    if (!kernel.fieldMask(name, scope).includes(field)) throw new QueryError('field_forbidden', path)
  }
  function permission(name: string, path: QueryPath) {
    try { kernel.readPermission(scope, name) } catch (error) { if (legacyErrors) throw error; throw new QueryError(path.length ? 'relation_forbidden' : 'field_forbidden', path) }
  }
  function relation(name: string, key: string, path: QueryPath) {
    const r = kernel.config.entities[name].relations[key]
    const fkEntity = r.many ? r.entity : name
    if (!kernel.fieldMask(fkEntity, scope).includes(r.field) || !kernel.fieldMask(r.entity, scope).includes('id')) throw new QueryError('relation_forbidden', path)
    permission(r.entity, path); cost.relations++; return r
  }
  function where(name: string, node: Filter, depth: number, path: QueryPath, nesting = 0, expressionContext = path.join('/'), rows = 1) {
    cost.nodes++; cost.depth = Math.max(cost.depth, depth)
    if (nesting > L.filterDepth) throw new QueryError('query_too_expensive', path, cost)
    for (const [key, value] of Object.entries(node)) {
      if (key === 'and' || key === 'or') (value as Filter[]).forEach((v, i) => where(name, v, depth, [...path, key, i], nesting + 1, expressionContext, rows))
      else if (key === 'not') where(name, value as Filter, depth, [...path, key], nesting + 1, expressionContext, rows)
      else if (Object.hasOwn(kernel.config.entities[name].relations, key)) {
        const r = relation(name, key, [...path, key]); cost.exists++
        foreignKeyCost(r.entity)
        const quantifier = r.many ? Object.keys(value as object)[0] : undefined
        where(r.entity, (quantifier ? (value as Record<string, Filter>)[quantifier] : value) as Filter, depth + 1,
          [...path, key, ...(quantifier ? [quantifier] : [])], nesting + 1, `${expressionContext}/${key}`, rows)
      } else { readable(name, key, [...path, key]); expressionCost(name, key, expressionContext, rows) }
    }
  }
  function selection(name: string, node: Selection, depth: number, parents: number, path: QueryPath, single = false) {
    foreignKeyCost(name)
    permission(name, path); cost.depth = Math.max(cost.depth, depth)
    const limit = single ? 1 : node.limit ?? L.children
    const context = path.join('/'); const rows = parents * limit
    const fields = node.select ?? kernel.fieldMask(name, scope)
    fields.forEach((f, i) => { readable(name, f, [...path, 'select', i]); expressionCost(name, f, context, rows) })
    // Stable ordering, cursor keys and relation assembly all require readable id.
    readable(name, 'id', [...path, 'orderBy'])
    const labelKeys = [...new Set([...(node.labels ?? []), ...Object.keys((node as QueryInput).labelWhere ?? {}), ...((node as QueryInput).search?.fields ?? []).filter(key => labelPath(kernel.config, name, key)), ...(node.orderBy ?? []).filter(o => o.label).map(o => o.field)])]
    const joinedPaths = new Set<string>()
    for (const key of labelKeys) {
      const plan = labelPath(kernel.config, name, key)
      if (!plan) return invalid([...path, 'labels'])
      readable(name, plan.hops[0].field, [...path, 'labels'])
      cost.depth = Math.max(cost.depth, depth + plan.hops.length)
      let joinedPath = ''
      for (const hop of plan.hops) {
        joinedPath += `/${hop.field}`
        if (!joinedPaths.has(joinedPath)) { joinedPaths.add(joinedPath); cost.relations++; foreignKeyCost(hop.target) }
      }
      if (plan.display) expressionCost(plan.entity, plan.display, `${context}/label/${key}`, rows)
      for (const hop of plan.hops) expressionCost(hop.source, hop.field, context, rows)
      cost.fieldRows += parents * limit * 2
    }
    for (const key of (node as QueryInput).search?.fields ?? []) if (!labelPath(kernel.config, name, key)) { readable(name, key, [...path, 'search', 'fields']); expressionCost(name, key, context, rows) }
    node.orderBy?.forEach((o, i) => { if (!o.label) { readable(name, o.field, [...path, 'orderBy', i, 'field']); expressionCost(name, o.field, context, rows) } })
    cost.fieldRows += parents * limit * fields.length
    if (node.where) where(name, node.where, depth, [...path, 'where'], 0, context, rows)
    for (const [key, child] of Object.entries(node.include ?? {})) {
      const r = relation(name, key, [...path, 'include', key])
      selection(r.entity, child, depth + 1, parents * limit, [...path, 'include', key], !r.many)
    }
  }
  selection(entity, query, 0, 1, [])
  if (cost.depth > L.relationDepth || cost.relations > L.relations || cost.exists > L.exists || cost.fieldRows > L.fieldRows || cost.nodes > L.nodes)
    throw new QueryError('query_too_expensive', [], cost)
  return { query, cost }
}
