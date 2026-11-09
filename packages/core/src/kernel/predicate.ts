import { quote } from '../migrations/schema'
import type { Predicate, PredicateActorLink, PredicateRelation, PredicateValue, TableFilter } from './plugin'

export class PolicyExpansionLimit extends Error {}

/** Expand every related source before separating mandatory request authority from
 * row selection. Both read and pre/post-image compilers consume this same tree;
 * renderers must not introduce another table policy inside a quantifier. */
export function expandPolicyFilter(entity: string, tableFilter: (entity: string) => TableFilter, maxReferences = 64): TableFilter {
  let references = 0
  const authorities = new Map<string, Omit<PredicateActorLink, 'entity'>>()
  function authority(link: Omit<PredicateActorLink, 'entity'>) {
    const key = JSON.stringify([link.organizationId, link.accountId, link.membershipRole, link.token?.id, link.token?.role])
    authorities.set(key, link)
  }
  function visit(node: Predicate): Predicate {
    if ('actorAuthority' in node) {
      authority(node.actorAuthority as Omit<PredicateActorLink, 'entity'>)
      return { all: [] }
    }
    if ('actorLinkedIn' in node) {
      const { entity: _entity, ...link } = node.actorLinkedIn as PredicateActorLink
      authority(link)
      return node
    }
    if ('all' in node && Array.isArray(node.all)) return { all: (node.all as Predicate[]).map(visit) }
    if ('any' in node && Array.isArray(node.any)) return { any: (node.any as Predicate[]).map(visit) }
    if ('not' in node) return { not: visit(node.not as Predicate) }
    const key = 'exists' in node ? 'exists' : 'notExists' in node ? 'notExists' : undefined
    if (!key) return node
    const relation = (node as Record<string, PredicateRelation>)[key]
    const scoped = expand(relation.entity)
    const expanded = { ...relation, predicate: { all: [scoped, visit(relation.predicate)] } }
    return key === 'exists' ? { exists: expanded } : { notExists: expanded }
  }
  function expand(entity: string, filter = tableFilter(entity)): Predicate {
    if (++references > maxReferences) throw new PolicyExpansionLimit('Expanded policy graph exceeds table reference budget')
    filter.actorAuthorities?.forEach(authority)
    return filter.kind === 'where' ? visit(filter.predicate) : filter.kind === 'all' ? { all: [] } : { any: [] }
  }
  const root = tableFilter(entity)
  const expanded = expand(entity, root)
  if (root.kind !== 'where' && !authorities.size) return root
  return { ...root, kind: 'where', predicate: authorities.size ? { all: [...authorities.values()].map(link => ({ actorAuthority: link } as Predicate)).concat(expanded) } : expanded }
}

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
    if (Object.hasOwn(node, 'actorAuthority')) {
      if (entries.length !== 1 || negated) throw new Error('Invalid actor authority predicate')
      const link = (node as { actorAuthority: Omit<PredicateActorLink, 'entity'> }).actorAuthority
      // The policy compiler hoists this mandatory conjunct outside all Boolean
      // operators and relation quantifiers. Pin roles and issuer at execution.
      return `(EXISTS(SELECT 1 FROM memberships AS __actor_link_member
        JOIN users AS __actor_link_account ON __actor_link_account.id=__actor_link_member.user_id AND __actor_link_account.organization_id=__actor_link_member.organization_id
        ${link.token ? 'JOIN access_tokens AS __actor_link_token ON __actor_link_token.issuer_id=__actor_link_member.user_id AND __actor_link_token.organization_id=__actor_link_member.organization_id' : ''}
        WHERE __actor_link_member.organization_id=${alias}.organization_id AND __actor_link_member.organization_id=${bind(link.organizationId)}
        AND __actor_link_member.user_id=${bind(link.accountId)} AND __actor_link_member.role=${bind(link.membershipRole)}
        ${link.token ? `AND __actor_link_token.id=${bind(link.token.id)} AND __actor_link_token.role=${bind(link.token.role)} AND __actor_link_token.revoked_at IS NULL AND __actor_link_token.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')` : ''}))`
    }
    if (Object.hasOwn(node, 'actorLinkedIn')) {
      if (entries.length !== 1) throw new Error('Invalid actorLinkedIn predicate')
      const link = (node as { actorLinkedIn: PredicateActorLink }).actorLinkedIn
      // Only link presence is negatable. Bypass target read policies/transforms
      // with one indexed lookup per predicate, without per-row policy recursion.
      return `(${negated ? 'NOT ' : ''}EXISTS(SELECT 1 FROM ${quote(link.entity)} AS __actor_link
        WHERE __actor_link.organization_id=${alias}.organization_id AND __actor_link.organization_id=${bind(link.organizationId)} AND __actor_link.user=${bind(link.accountId)}))`
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
