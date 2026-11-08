import { readableComputed } from './query/expressions'
import type { KernelRegistry } from './kernel/registry'
import type { Scope } from './types'
import type { ConsoleGrant, ConsoleModelCapabilities } from './console-contract'
import { labelDependencies, labelPath } from './query/labels'
import { fieldsFor, validateQuery, type QueryInput, type Selection } from './query/schema'
import { QueryError } from './query/errors'

/** One fail-closed authority for every disclosed field, literal and presentation dependency. */
export function consoleAuthorization(kernel: KernelRegistry, scope: Scope, caps: ConsoleModelCapabilities) {
  const config = kernel.config
  const readable = new Map(Object.entries(config.entities).map(([entity]) => [entity, new Set(
    fieldsFor(config, entity).filter(field => caps.entities[entity]?.operations.includes('read')
      && caps.entities[entity].readable.includes('id') && caps.entities[entity].readable.includes(field)),
  )]))
  const operation = (entity: string, operation: string) => readable.has(entity) && caps.entities[entity]?.operations.includes(operation) === true
  const command = (name: string) => caps.commands.includes(name)
  const grant = (grant?: ConsoleGrant) => !grant || (typeof grant === 'string' ? caps.resources[grant] === true : operation(grant.entity, grant.operation ?? 'read'))
  const canRead = (entity: string) => readable.get(entity)?.has('id') === true
  function readableField(entity: string, field: string): boolean {
    if (!readable.get(entity)?.has(field)) return false
    const spec = config.entities[entity].fields[field]
    return spec?.type !== 'ref' || !!spec.entity && canRead(spec.entity)
  }
  function read(entity: string, field: string): boolean {
    if (!readableField(entity, field) || !readableComputed(kernel, scope, entity, field)) return false
    const spec = config.entities[entity]
    return field !== spec.displayField || !spec.label || labelDependencies(config, entity).every(dependency => readableField(dependency.entity, dependency.field))
  }
  const write = (entity: string, field: string, action: 'create' | 'update') => !!config.entities[entity]?.fields[field]
    && !config.entities[entity].fields[field].readOnly && operation(entity, action)
    && caps.entities[entity].writable.includes(field)
  // Read access can include sensitive data; configured literals must never disclose
  // those values, including values derived from sensitive display-label operands.
  function literals(entity: string, field: string): boolean {
    if (!read(entity, field) || config.entities[entity]?.fields[field]?.sensitive) return false
    const spec = config.entities[entity]
    return field !== spec.displayField || !spec.label || labelDependencies(config, entity)
      .every(dependency => !config.entities[dependency.entity].fields[dependency.field]?.sensitive)
  }
  const defaults = (entity: string, field: string) => literals(entity, field) && (write(entity, field, 'create') || write(entity, field, 'update'))
  function relation(entity: string, key: string) {
    const r = config.entities[entity]?.relations[key]
    return r && read(entity, 'id') && read(r.entity, 'id') && read(r.many ? r.entity : entity, r.field)
      && (!r.through || read(r.entity, r.through.field) && read(r.through.entity, 'id')) ? r : undefined
  }
  function label(entity: string, key: string): boolean {
    const path = labelPath(config, entity, key)
    return !!path && path.hops.every(hop => literals(hop.source, hop.field) && canRead(hop.target))
      && !!path.display && literals(path.entity, path.display)
  }
  function predicateFields(entity: string, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, value]) => {
      if (key === 'and' || key === 'or') return Array.isArray(value) && value.every(child => predicateFields(entity, child))
      if (key === 'not') return !!value && typeof value === 'object' && predicateFields(entity, value as Record<string, unknown>)
      const r = config.entities[entity]?.relations[key]
      if (!r) return literals(entity, key)
      return !!relation(entity, key) && literals(r.many ? r.entity : entity, r.field)
        && predicateFields(r.entity, (r.many ? Object.values(value as object)[0] : value) as Record<string, unknown>)
    })
  }
  function selection(entity: string, node: Selection): boolean {
    const root = node as QueryInput
    return canRead(entity) && (node.select ?? caps.entities[entity].readable).every(field => read(entity, field))
      && (!node.where || predicateFields(entity, node.where))
      && (node.labels ?? []).every(key => label(entity, key))
      && Object.keys(root.labelWhere ?? {}).every(key => label(entity, key))
      && (root.search?.fields ?? []).every(key => labelPath(config, entity, key) ? label(entity, key) : literals(entity, key))
      && (node.orderBy ?? []).every(order => order.label ? label(entity, order.field) : literals(entity, order.field))
      && Object.entries(node.include ?? {}).every(([key, child]) => {
        const r = relation(entity, key)
        return !!r && selection(r.entity, child)
      })
  }
  function query(input: unknown): QueryInput | undefined {
    try {
      const { query } = validateQuery(kernel, scope, input)
      return selection(query.entity, query) ? query : undefined
    } catch (error) { if (error instanceof QueryError) return undefined; throw error }
  }
  const predicate = (entity: string, where: Record<string, unknown>) => !!query({ entity, select: ['id'], limit: 1, where })
  const schema = (node: Record<string, unknown>) => node.sensitive !== true
    && (node.referenceEntity === undefined || typeof node.referenceEntity === 'string' && canRead(node.referenceEntity))
  return { operation, command, grant, canRead, read, write, literals, defaults, relation, label, query, predicate, schema }
}
export type ConsoleAuthorization = ReturnType<typeof consoleAuthorization>
