import { organizationPermission } from '../execution/permissions'
import { userLinks } from '../user-links'
import { z } from 'zod'
import { baseFields, type Field, type InstanceConfig } from '../config'
import type { KernelRegistry } from '../kernel/registry'
import type { Scope } from '../types'
import { invalid, QueryError, type QueryPath } from './errors'
import { QUERY_LIMITS as L, type QueryCost } from './limits'
import { isRestQuery } from './facade'
import { labelPath } from './labels'
import { expressionInfo, fieldExpression, readableComputed } from './expressions'

export type Scalar = string | number | boolean | null
export interface Filter { [key: string]: unknown }
export interface Order { field: string; dir: 'asc' | 'desc'; label?: boolean }
export interface Selection { labels?: string[]; select?: string[]; where?: Filter; orderBy?: Order[]; limit?: number; include?: Record<string, Selection> }
export type RowAccessState = 'no_account' | 'invited' | 'expired' | 'signed_in'
export interface QueryInput extends Selection { rowAccess?: RowAccessState; contextList?: { entity: string; list: string; id: string }; search?: { text: string; fields: string[]; locale?: 'en' | 'cs' }; labelWhere?: Record<string, { contains: string; locale?: 'en' | 'cs' }>; entity: string; limit: number; cursor?: string }
export const fieldsFor = (config: InstanceConfig, entity: string) => [...baseFields, ...Object.keys(config.entities[entity].fields)]
export function fieldType(config: InstanceConfig, entity: string, field: string): Field['type'] {
  return config.entities[entity].fields[field]?.type ?? (field === 'version' ? 'int' : ['created_at', 'updated_at'].includes(field) ? 'datetime' : 'string')
}
export function operatorsFor(type: Field['type']) {
  return ['eq', 'ne', 'in', ...(['bool'].includes(type) ? [] : ['lt', 'lte', 'gt', 'gte']),
    ...(['string', 'text'].includes(type) ? ['contains'] : []), 'isNull']
}
function valueSchema(config: InstanceConfig, entity: string, field: string, rest: boolean) {
  const type = fieldType(config, entity, field)
  // crud.ts accepted all finite numeric operands (also for int fields), and did
  // not impose the write validator's string lengths on URL filter operands.
  if (rest) return type === 'bool' ? z.boolean() : ['int', 'float'].includes(type) ? z.number().finite() : z.string()
  return type === 'bool' ? z.boolean() : type === 'int' ? z.number().int().safe()
    : type === 'float' ? z.number().finite() : z.string().max(2_000)
}
/** Shared client/policy grammar; only trusted configuration enables actor predicates. */
export function filterSchema(config: InstanceConfig, rest = false, maxDepth = L.relationDepth as number,
  actorValues?: (type: Field['type']) => z.ZodType) {
  const filters = new Map<string, z.ZodType>()
  function filter(name: string, depth: number): z.ZodType {
    const key = `${name}:${depth}`
    const cached = filters.get(key); if (cached) return cached
    const schema: z.ZodType = z.lazy(() => {
      const shape: Record<string, z.ZodType> = Object.create(null)
      for (const field of fieldsFor(config, name)) {
        const scalar = (valueSchema(config, name, field, rest) as z.ZodType).refine((value: unknown) => !actorValues || typeof value !== 'string' || !value.startsWith('$actor.'), 'Actor values require a declared compatible field'); const value = actorValues ? z.union([scalar, actorValues(fieldType(config, name, field))]) : scalar; const ops: Record<string, z.ZodType> = Object.create(null)
        for (const op of rest ? ['eq', 'lt', 'lte', 'gt', 'gte'] : operatorsFor(fieldType(config, name, field))) ops[op] =
          (op === 'isNull' ? (actorValues ? z.union([z.boolean(), actorValues('bool')]) : z.boolean()) : op === 'in' ? z.array(value.nullable()).max(L.bindings)
            : op === 'eq' || op === 'ne' ? value.nullable() : value).optional()
        shape[field] = z.strictObject(ops).refine(v => Object.keys(v).length > 0).optional()
      }
      if (depth < maxDepth) for (const [relation, r] of Object.entries(config.entities[name].relations)) {
        const child = filter(r.entity, depth + 1)
        shape[relation] = (r.many ? z.union([z.strictObject({ some: child }), z.strictObject({ none: child })]) : child).optional()
      }
      if (actorValues) shape.actorLinkedIn = z.string().refine(entity =>
        Object.hasOwn(config.entities, entity) && Object.values(config.entities[entity].fields).some(field => field.userLink),
      'actorLinkedIn requires an entity with a protected user link').optional()
      shape.and = z.array(schema).min(1).max(L.nodes).optional()
      shape.or = z.array(schema).min(1).max(L.nodes).optional()
      shape.not = schema.optional()
      return z.strictObject(shape)
    })
    filters.set(key, schema); return schema
  }
  return filter
}
/** Generated from the complete model. No library AST/raw/functions are client input. */
export function querySchema(config: InstanceConfig, entity: string, rest = false) {
  const filter = filterSchema(config, rest)
  function selection(name: string, depth: number, root: boolean): z.ZodType {
    const names = fieldsFor(config, name) as [string, ...string[]]
    const labelNames = [...names.filter(key => labelPath(config, name, key)), ...Object.keys(config.ui?.entities?.[name]?.list?.relatedColumns ?? {})] as [string, ...string[]]
    const shape: Record<string, z.ZodType> = {
      select: z.array(z.enum(names)).min(1).max(names.length).refine(v => new Set(v).size === v.length).optional(),
      where: filter(name, depth).optional(),
      orderBy: z.array(z.strictObject({ field: z.enum(root ? [...new Set([...names, ...labelNames])] as [string, ...string[]] : names), dir: z.enum(['asc', 'desc']), ...(root ? { label: z.boolean().optional() } : {}) })).max(5)
        .refine(v => new Set(v.map(o => o.field)).size === v.length).optional(),
      limit: root ? z.number().int().min(1).max(L.root) : z.number().int().min(1).max(L.children).optional(),
    }
    if (depth < L.relationDepth) shape.include = z.strictObject(Object.fromEntries(Object.entries(config.entities[name].relations)
      .map(([key, r]) => [key, z.lazy(() => selection(r.entity, depth + 1, false)).optional()]))).optional()
    if (root) {
      if (labelNames.length) {
        shape.labelWhere = z.partialRecord(z.enum(labelNames), z.strictObject({ contains: z.string().min(1).max(2000), locale: z.enum(['en', 'cs']).optional() })).optional()
        shape.labels = z.array(z.enum(labelNames)).max(L.relations).refine(v => new Set(v).size === v.length).optional()
      }
      shape.search = z.strictObject({ text: z.string().min(1).max(2000), fields: z.array(z.enum([...new Set([...names, ...labelNames])] as [string, ...string[]])).min(1).max(names.length + labelNames.length).refine(v => new Set(v).size === v.length), locale: z.enum(['en', 'cs']).optional() }).optional()
      shape.contextList = z.strictObject({ entity: z.string().regex(/^[a-z][a-z0-9_]*$/).max(100), list: z.string().regex(/^[a-z][a-z0-9_]*$/).max(100), id: z.string().min(1).max(2000) }).optional()
      shape.rowAccess = z.enum(['no_account', 'invited', 'expired', 'signed_in']).optional()
      shape.entity = z.literal(name); shape.cursor = z.string().min(1).max(L.cursorBytes).optional()
    }
    return z.strictObject(shape)
  }
  return selection(entity, 0, true)
}
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
