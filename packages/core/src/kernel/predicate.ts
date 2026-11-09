import { quote } from '../migrations/schema'
import type { Predicate, PredicateActorLink, PredicateRelation, PredicateValue } from './plugin'

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
  function render(node: Predicate, negated = false): string {
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('Invalid predicate')
    const entries = Object.entries(node)
    if (!entries.length) throw new Error('Empty predicate')
    const logical = entries.find(([key, value]) => (key === 'all' || key === 'any') && Array.isArray(value))
    if (logical) {
      if (entries.length !== 1) throw new Error('Invalid predicate combinator')
      const [key, children] = logical as ['all' | 'any', Predicate[]]
      const all = (key === 'all') !== negated
      return `(${children.length ? children.map(child => render(child, negated)).join(all ? ' AND ' : ' OR ') : all ? '1=1' : '0=1'})`
    }
    if (Object.hasOwn(node, 'not')) {
      if (entries.length !== 1) throw new Error('Invalid predicate combinator')
      return render((node as { not: Predicate }).not, !negated)
    }
    if (Object.hasOwn(node, 'actorLinkedIn')) {
      if (entries.length !== 1) throw new Error('Invalid actorLinkedIn predicate')
      const link = (node as { actorLinkedIn: PredicateActorLink }).actorLinkedIn
      // Deliberately bypass table transforms/target read policies. This authority
      // probe has one EXISTS and indexed organization/user, membership and PK joins.
      // Pin both roles and the token issuer so a prepare/batch race fails closed.
      // Push Boolean negation down to link presence, keeping live authority
      // mandatory even under NOT. Absence is checked by an indexed LEFT JOIN.
      // Underscore-prefixed aliases cannot collide with configured entity names.
      return `(EXISTS(SELECT 1 FROM memberships AS __actor_link_member
        JOIN users AS __actor_link_account ON __actor_link_account.id=__actor_link_member.user_id AND __actor_link_account.organization_id=__actor_link_member.organization_id
        ${link.token ? 'JOIN access_tokens AS __actor_link_token ON __actor_link_token.issuer_id=__actor_link_member.user_id AND __actor_link_token.organization_id=__actor_link_member.organization_id' : ''}
        ${negated ? 'LEFT ' : ''}JOIN ${quote(link.entity)} AS __actor_link ON __actor_link.user=__actor_link_member.user_id AND __actor_link.organization_id=__actor_link_member.organization_id
        WHERE __actor_link_member.organization_id=${alias}.organization_id AND __actor_link_member.organization_id=${bind(link.organizationId)}
        AND __actor_link_member.user_id=${bind(link.accountId)} AND __actor_link_member.role=${bind(link.membershipRole)}
        ${link.token ? `AND __actor_link_token.id=${bind(link.token.id)} AND __actor_link_token.role=${bind(link.token.role)} AND __actor_link_token.revoked_at IS NULL AND __actor_link_token.expires_at>${bind(link.token.now)}` : ''}
        ${negated ? 'AND __actor_link.user IS NULL' : ''}))`
    }
    const relationKey = Object.hasOwn(node, 'exists') ? 'exists' : Object.hasOwn(node, 'notExists') ? 'notExists' : undefined
    if (relationKey) {
      if (entries.length !== 1 || !renderRelation) throw new Error('Relation predicate requires scoped compiler')
      const relation = (node as Record<string, PredicateRelation>)[relationKey]
      if (!relation || Object.keys(relation).length !== 4 || !['entity', 'field', 'parentField', 'predicate'].every(key => Object.hasOwn(relation, key))
        || ![relation.entity, relation.field, relation.parentField].every(value => typeof value === 'string')) throw new Error('Invalid predicate relation')
      quote(relation.entity); quote(relation.field); quote(relation.parentField)
      return `(${renderRelation(relation, tableAlias, (relationKey === 'notExists') !== negated)})`
    }
    const scalar = `(${entries.flatMap(([field, operators]) => {
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
    return negated ? `(NOT ${scalar})` : scalar
  }
  return { sql: render(predicate), bindings }
}
