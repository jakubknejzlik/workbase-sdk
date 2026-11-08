import { ApiError } from '../errors'
import type { QueryCost } from './limits'
export type QueryCode = 'query_invalid' | 'field_forbidden' | 'relation_forbidden' | 'query_too_expensive' | 'entity_not_found' | 'policy_violation'
export type QueryPath = (string | number)[]
export class QueryError extends ApiError {
  constructor(code: QueryCode, public path: QueryPath = [], public cost?: QueryCost) {
    super(code === 'entity_not_found' ? 404 : code.endsWith('forbidden') || code === 'policy_violation' ? 403 : 400, code)
  }
}
export const invalid = (path: QueryPath = []): never => { throw new QueryError('query_invalid', path) }
