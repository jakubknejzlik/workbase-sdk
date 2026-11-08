import { quote } from '../migrations/schema'
import type { Predicate, PredicateRelation, PredicateValue } from './plugin'

/** Structured predicates only. The query compiler supplies the active library value/EXISTS renderers. */
export function renderPredicate(predicate: Predicate, tableAlias: string,
  bindValue?: (value: Exclude<PredicateValue, null>) => string,
  renderRelation?: (relation: PredicateRelation, parentAlias: string, negated: boolean) => string,
): { sql: string; bindings: unknown[] } {
  const alias = quote(tableAlias); const bindings: unknown[] = []
  function bind(value: unknown): string {
    if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('Invalid predicate value')
    if (bindValue) return bindValue(value as Exclude<PredicateValue, null>)
    bindings.push(typeof value === 'boolean' ? Number(value) : value); return '?'
  }
  function render(node: Predicate): string {
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('Invalid predicate')
    const entries = Object.entries(node)
    if (!entries.length) throw new Error('Empty predicate')
    const logical = entries.find(([key, value]) => (key === 'all' || key === 'any') && Array.isArray(value))
    if (logical) {
      if (entries.length !== 1) throw new Error('Invalid predicate combinator')
      const [key, children] = logical as ['all' | 'any', Predicate[]]
      return `(${children.length ? children.map(render).join(key === 'all' ? ' AND ' : ' OR ') : key === 'all' ? '1=1' : '0=1'})`
    }
    if (Object.hasOwn(node, 'not')) {
      if (entries.length !== 1) throw new Error('Invalid predicate combinator')
      return `(NOT ${render((node as { not: Predicate }).not)})`
    }
    const relationKey = Object.hasOwn(node, 'exists') ? 'exists' : Object.hasOwn(node, 'notExists') ? 'notExists' : undefined
    if (relationKey) {
      if (entries.length !== 1 || !renderRelation) throw new Error('Relation predicate requires scoped compiler')
      const relation = (node as Record<string, PredicateRelation>)[relationKey]
      if (!relation || Object.keys(relation).length !== 4 || !['entity', 'field', 'parentField', 'predicate'].every(key => Object.hasOwn(relation, key))
        || ![relation.entity, relation.field, relation.parentField].every(value => typeof value === 'string')) throw new Error('Invalid predicate relation')
      quote(relation.entity); quote(relation.field); quote(relation.parentField)
      return `(${renderRelation(relation, tableAlias, relationKey === 'notExists')})`
    }
    return `(${entries.flatMap(([field, operators]) => {
      const column = `${alias}.${quote(field)}`
      if (!operators || typeof operators !== 'object' || Array.isArray(operators) || !Object.keys(operators).length) throw new Error('Invalid predicate operator')
      return Object.entries(operators).map(([op, value]) => {
        if (op === 'isNull') {
          if (typeof value !== 'boolean') throw new Error('Invalid predicate value')
          return `${column} IS ${value ? '' : 'NOT '}NULL`
        }
        if ((op === 'eq' || op === 'ne') && value === null) return `${column} IS ${op === 'eq' ? '' : 'NOT '}NULL`
        if (op === 'in') {
          if (!Array.isArray(value)) throw new Error('Invalid predicate value')
          if (!value.length) return '0=1'
          const values = value.filter(v => v !== null).map(v => {
            if (!['string', 'number', 'boolean'].includes(typeof v) || typeof v === 'number' && !Number.isFinite(v)) throw new Error('Invalid predicate value')
            return typeof v === 'boolean' ? Number(v) : v
          })
          // D1 binds JS numbers as REAL. CASE removes RHS affinity; only JSON numbers are cast.
          const parts = [...(values.length ? [`${column} IN (SELECT CASE WHEN type IN ('integer', 'real') THEN CAST(value AS REAL) ELSE value END FROM json_each(${bind(JSON.stringify(values))}))`] : []), ...(value.includes(null) ? [`${column} IS NULL`] : [])]
          return `(${parts.join(' OR ')})`
        }
        if (op === 'contains') {
          if (typeof value !== 'string') throw new Error('Invalid predicate value')
          return `instr(${column},${bind(value)})>0`
        }
        const sqlOp = ({ eq: '=', ne: '!=', lt: '<', lte: '<=', gt: '>', gte: '>=' } as Record<string, string>)[op]
        if (!sqlOp || !Object.hasOwn({ eq: 1, ne: 1, lt: 1, lte: 1, gt: 1, gte: 1 }, op)) throw new Error('Invalid predicate operator')
        return `${column}${sqlOp}${bind(value)}`
      })
    }).join(' AND ')})`
  }
  return { sql: render(predicate), bindings }
}
