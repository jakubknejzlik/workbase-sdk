import type { InstanceConfig } from '../config'
import { ApiError } from '../errors'
import type { Filter, QueryInput } from './schema'
// Only server-created translations receive the legacy operand grammar. A JSON
// property (or executeQuery's error-vocabulary option) cannot opt /query into it.
const translations = new WeakSet<object>()
export const isRestQuery = (input: unknown) => typeof input === 'object' && input !== null && translations.has(input)
/** Keep the existing REST vocabulary and cursor bytes; the execution engine is shared. */
export function restQuery(config: InstanceConfig, entity: string, params: Record<string, string>, id?: string): QueryInput {
  if (!Object.hasOwn(config.entities, entity)) throw new ApiError(404, 'entity_not_found')
  const definition = config.entities[entity]
  const limit = id === undefined ? Number(params.limit ?? '25') : 1
  if (!Number.isInteger(limit) || limit < 1 || limit > 90) throw new ApiError(400, 'invalid_limit')
  const filters: Filter[] = id === undefined ? [] : [{ id: { eq: id } }]
  if (id === undefined) {
    if (params.cursor) filters.push({ id: { gt: params.cursor } })
    for (const [key, input] of Object.entries(params)) {
      if (['limit', 'cursor', 'expand'].includes(key)) continue
      const match = /^(\w+)(?:\[(gte|lte|gt|lt)\])?$/.exec(key)
      if (!match || !Object.hasOwn(definition.fields, match[1])) throw new ApiError(400, 'unknown_filter')
      const field = definition.fields[match[1]]; let value: string | number | boolean = input
      if (['int', 'float'].includes(field.type)) { value = Number(input); if (!Number.isFinite(value)) throw new ApiError(400, 'invalid_filter') }
      if (field.type === 'bool') { if (!['true', 'false', '1', '0'].includes(input)) throw new ApiError(400, 'invalid_filter'); value = ['true', '1'].includes(input) }
      filters.push({ [match[1]]: { [match[2] ?? 'eq']: value } })
    }
  }
  const expansions = params.expand?.split(',').filter(Boolean) ?? []
  if (expansions.length > 5) throw new ApiError(400, 'too_many_expansions')
  for (const key of expansions) if (!Object.hasOwn(definition.relations, key)) throw new ApiError(400, 'unknown_expansion')
  const query = { entity, limit, ...(filters.length ? { where: { and: filters } } : {}),
    ...(expansions.length ? { include: Object.fromEntries(expansions.map(key => [key, {}])) } : {}) }
  translations.add(query)
  return query
}
