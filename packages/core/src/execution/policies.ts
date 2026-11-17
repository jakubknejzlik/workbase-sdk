import { ApiError } from '../errors'
import { renderPredicate, type KernelRegistry } from '../kernel/registry'
import { expandPolicyFilter } from '../kernel/predicate'
import type { Predicate, PredicateRelation, TableFilter } from '../kernel/plugin'
import { actorAccountId, canManageAccountAssignments, protectedActorFields } from '../policies'
import { quote } from '../migrations/schema'
import type { Scope } from '../types'
import type { AtomicPlan, GuardedStatement, PolicyWriteGuard, SqlStatement, SqlValue } from './types'
import { UnsupportedAtomicOperation } from './errors'
import { assertUnprotectedFields, userLinkWriter, userLinkPolicyFilter } from '../user-links'

export type WriteGuard = PolicyWriteGuard
export const writeGuard = (statement: GuardedStatement) => Object.hasOwn(statement, 'policyGuard') ? statement.policyGuard : undefined
/** Same structured predicate semantics as query table sources, including scoped EXISTS. */
export function writeFilter(kernel: KernelRegistry, scope: Scope, entity: string, alias = entity, operation: import('../config').Operation = 'read', rootFilter?: TableFilter): SqlStatement {
  const bindings: SqlValue[] = []; let references = 0
  const bind = (value: string | number | boolean) => { bindings.push(typeof value === 'boolean' ? Number(value) : value); return '?' }
  function render(filter: TableFilter, table: string): string {
    if (++references > 128) throw new ApiError(403, 'policy_violation')
    return filter.kind === 'where' ? renderPredicate(filter.predicate, table, bind, relation).sql : filter.kind === 'all' ? '1=1' : '0=1'
  }
  function relation(node: PredicateRelation, parent: string, negated: boolean): string {
    const child = `write_policy_${references}`
    let explicit = render({ kind: 'where', predicate: node.predicate }, child)
    if (kernel.config.effectiveAccess) { explicit = `${explicit} AND ${quote(child)}.organization_id=?`; bindings.push(scope.organizationId) }
    // Put policy expressions inside the derived source, as the read compiler does.
    // SQLite's expression-depth cap then does not accumulate the complete target
    // policy tree at every correlation along a four-relation path.
    const visible = `${child}_visible`
    return `${negated ? 'NOT ' : ''}EXISTS(SELECT 1 FROM (SELECT ${quote(child)}.${quote(node.field)} AS ${quote('policy_key')} FROM ${quote(node.entity)} AS ${quote(child)} WHERE ${explicit}) AS ${quote(visible)} WHERE ${quote(visible)}.${quote('policy_key')}=${quote(parent)}.${quote(node.parentField)})`
  }
  let filter: TableFilter
  let root = true
  try { filter = expandPolicyFilter(entity, child => {
    const selected = root && rootFilter ? rootFilter : kernel.tableFilter(child, scope, operation)
    root = false
    return selected
  }, 128) }
  catch { throw new ApiError(403, 'policy_violation') }
  let sql = render(filter, alias)
  if (kernel.config.effectiveAccess) { sql = `(${sql}) AND ${quote(alias)}.organization_id=?`; bindings.push(scope.organizationId) }
  if (bindings.length > 100 || sql.length > 64_000) throw new ApiError(403, 'policy_violation')
  return { sql, bindings }
}

interface Token { text: string; start: number; end: number; depth: number; binding: number }
/** A bounded SQL lexer for trusted single-table DML, never a client SQL interface.
 * Unsupported write shapes fail closed when a policy needs enforcement. */
function tokens(sql: string): Token[] {
  const result: Token[] = []; let depth = 0; let binding = 0
  const pattern = /\s+|'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\]|[a-zA-Z_][a-zA-Z_0-9]*|\?|[0-9]+|./g
  for (const match of sql.matchAll(pattern)) {
    const text = match[0]; if (/^\s+$/.test(text)) continue
    if (text === ')') depth--
    result.push({ text, start: match.index!, end: match.index! + text.length, depth, binding })
    if (text === '?') binding++
    if (text === '(') depth++
  }
  return result
}
const identifier = (token: Token) => token.text.replace(/^["`\[]|["`\]]$/g, '').toLowerCase()
function operand(token: Token, bindings: readonly SqlValue[]): SqlValue {
  if (token.text === '?') return bindings[token.binding]
  if (/^'/.test(token.text)) return token.text.slice(1, -1).replaceAll("''", "'")
  throw new UnsupportedAtomicOperation('Policy INSERT requires a constant or bound id')
}
export function enforcePlan(kernel: KernelRegistry, scope: Scope, plan: AtomicPlan, memberManagement?: 'update' | 'create'): AtomicPlan {
  // This invariant also applies to service workflow compensation, independently
  // of row-policy bypass. Only core-minted, immutable statements may write links.
  for (const rule of plan.rules) for (const statement of rule.statements) {
    if (userLinkWriter(statement)) continue
    const ts = tokens(statement.sql)
    const operation = ts[0]?.text.toUpperCase()
    if (operation !== 'UPDATE' && operation !== 'INSERT') continue
    const linkIdentifier = (token: Token) => identifier(token).replace(/^'|'$/g, '')
    let targetIndex = ts[1]?.text.toUpperCase() === 'OR' ? 3 : 1
    if (operation === 'INSERT') targetIndex++ // INTO
    if (ts[targetIndex + 1]?.text === '.') targetIndex += 2 // main.table
    const target = ts[targetIndex]
    const definition = target && kernel.config.entities[linkIdentifier(target)]
    if (!definition || !Object.values(definition.fields).some(field => field.userLink)) continue
    if (ts[1]?.text.toUpperCase() === 'OR' && ts[2]?.text.toUpperCase() === 'REPLACE') throw new ApiError(400, 'protected_field')
    if (operation === 'INSERT') {
      // Keep the closed INSERT dialect on linked entities, including service
      // writes: later conflict arms must not introduce uninspected assignments.
      if (ts.some((token, index) => token.depth === 0 && token.text.toUpperCase() === 'ON' && ts[index + 1]?.text.toUpperCase() === 'CONFLICT')) throw new ApiError(400, 'protected_field')
      // Positional INSERT could write the link without naming it. Refuse it on
      // linked entities, including service effects that bypass row policies.
      if (ts[targetIndex + 1]?.text !== '(') throw new ApiError(400, 'protected_field')
      const close = ts.findIndex(token => token.text === ')' && token.depth === 0)
      assertUnprotectedFields(definition, ts.slice(targetIndex + 2, close).filter(token => token.text !== ',').map(linkIdentifier))
    }
    // Inspect UPDATE assignments, including tuple left-hand sides.
    const start = ts.findIndex(token => token.depth === 0 && token.text.toUpperCase() === 'SET')
    if (start >= 0) {
      const end = ts.findIndex((token, index) => index > start && token.depth === 0 && token.text.toUpperCase() === 'WHERE')
      const assignments = ts.slice(start + 1, end < 0 ? undefined : end)
      // Include tuple assignment LHSs, even though the policy dialect refuses them.
      const assigned: Token[] = []; let left = true
      for (const token of assignments) {
        if (token.depth === 0 && token.text === '=') left = false
        else if (token.depth === 0 && token.text === ',') left = true
        else if (left) assigned.push(token)
      }
      assertUnprotectedFields(definition, assigned.map(linkIdentifier))
    }
  }
  if (scope.actor.type === 'service' && scope.role === 'SYSTEM') return plan
  const protectedFields = protectedActorFields(kernel.config)
  return { ...plan, rules: plan.rules.map(rule => ({ ...rule, statements: rule.statements.map(original => {
    // Cascading revocation and stored invitation targets carry their own authority.
    if (userLinkWriter(original) === 'cleanup') return original
    const ts = tokens(original.sql); const top = ts.filter(t => t.depth === 0)
    const operation = ts[0]?.text.toUpperCase()
    const target = operation === 'UPDATE' ? ts[1] : operation === 'DELETE' ? ts[2] : operation === 'INSERT' && ts[1]?.text.toUpperCase() === 'INTO' ? ts[2] : undefined
    if (!target) throw new UnsupportedAtomicOperation('Unsupported policy DML shape')
    const entity = identifier(target).toLowerCase()
    if (target.text.startsWith("'") || ts[ts.indexOf(target) + 1]?.text === '.' || (operation === 'UPDATE' && ts[1]?.text.toUpperCase() === 'OR')) throw new UnsupportedAtomicOperation('Policy DML requires an unqualified identifier')
    const domain = Object.hasOwn(kernel.config.entities, entity)
    const account = entity === kernel.config.account?.entity
    const member = entity === 'memberships'
    if (account && ['INSERT', 'UPDATE'].includes(operation!) && memberManagement === 'create') return original
    // Existing system writers retain their narrowly authorized paths.
    if (!domain && !member) return original
    const liveFilter = userLinkPolicyFilter(original)
    const authoredOperation = operation!.toLowerCase() === 'insert' ? 'create' : operation!.toLowerCase() as 'update' | 'delete'
    if (!liveFilter && domain && kernel.tableFilter(entity, scope, authoredOperation).kind === 'none') throw new ApiError(403, 'policy_violation')
    const protect = account || member
    if (!domain && !protect) return original
    if (ts.some((token, i) => token.text === '?' && ts[i + 1]?.start === token.end && /^\d/.test(ts[i + 1].text)) || ts.some(token => [':', '@', '$'].includes(token.text))) throw new UnsupportedAtomicOperation('Policy SQL uses plain positional bindings')
    const bindings = original.bindings ?? []
    const statement = { ...original }
    const guard: WriteGuard = { entity, operation: operation!, requireRow: original.expectRows !== undefined, filter: liveFilter ?? (domain ? writeFilter(kernel, scope, entity, entity, authoredOperation) : { sql: `${quote(entity)}.${quote('organization_id')}=?`, bindings: [scope.organizationId] }) }
    if (operation === 'UPDATE' || operation === 'DELETE') {
      const where = top.find(t => t.text.toUpperCase() === 'WHERE')
      const set = top.find(t => t.text.toUpperCase() === 'SET')
      if (top.some(t => ['RETURNING', 'LIMIT', 'ORDER', 'FROM', 'WITH'].includes(t.text.toUpperCase()) && t !== ts[1]) && operation === 'UPDATE') throw new UnsupportedAtomicOperation('Policy mutation requires single-table DML')
      if (operation === 'UPDATE' && (!set || ts[ts.indexOf(target) + 1] !== set)) throw new UnsupportedAtomicOperation('Policy UPDATE aliases are unsupported')
      guard.where = { sql: where ? original.sql.slice(where.end) : '1=1', bindings: where ? bindings.slice(where.binding) : [] }
      if (operation === 'DELETE' && ts[ts.indexOf(target) + 1] && ts[ts.indexOf(target) + 1] !== where) throw new UnsupportedAtomicOperation('Policy DELETE aliases are unsupported')
      if (protect && operation === 'UPDATE') {
        const assignments = top.filter(t => t.start >= set!.end && t.start < (where?.start ?? Infinity))
        const starts = [0, ...assignments.flatMap((t, i) => t.text === ',' ? [i + 1] : [])]
        if (starts.some(i => !/^[a-z][a-z0-9_]*$/.test(identifier(assignments[i])) || assignments[i + 1]?.text !== '=')) throw new UnsupportedAtomicOperation('Protected fields require simple assignments')
        const assigned = starts.map(i => identifier(assignments[i]))
        const dependency = (field: string) => protectedFields.has(member && field === 'user_id' ? 'id' : field)
        if (assigned.some(field => dependency(field) || (member && ['user_id', 'role'].includes(field)))) {
          if (account) {
            // Additive account-assignment allowance, never a membership capability.
            // Capture checks every target, including bulk statements and unchanged values.
            if (!canManageAccountAssignments(kernel.config, scope, assigned.filter(dependency))) throw new ApiError(403, 'field_forbidden')
            guard.protected = { sql: `${quote(entity)}.${quote('id')}<>?`, bindings: [actorAccountId(scope)] }
          } else {
            if (memberManagement !== 'update') throw new ApiError(403, 'field_forbidden')
            if (assigned.some(dependency)) guard.protected = { sql: `${quote(entity)}.${quote('user_id')}<>?`, bindings: [actorAccountId(scope)] }
          }
        }
      }
      // Evaluate the original target predicate exactly once. The compiler mutates
      // these captured IDs, so volatile predicates and changes() cannot choose an
      // uncaptured post-image when evaluated a second time.
      guard.mutation = { sql: where ? original.sql.slice(0, where.start) : original.sql, bindings: where ? bindings.slice(0, where.binding) : bindings }
    } else if (operation === 'INSERT') {
      if (top.some(t => ['UNION', 'ON', 'RETURNING'].includes(t.text.toUpperCase()))) throw new UnsupportedAtomicOperation('Policy INSERT does not support unions or upserts')
      const open = ts[ts.indexOf(target) + 1]
      const closeIndex = ts.findIndex(t => t.text === ')' && t.depth === 0)
      const columns = ts.slice(ts.indexOf(open) + 1, closeIndex).filter(t => t.text !== ',').map(identifier)
      const source = ts[closeIndex + 1]
      if (source?.text.toUpperCase() === 'VALUES' && top.some(t => t.start > source.end && t.text === ',')) throw new UnsupportedAtomicOperation('Policy INSERT accepts one row')
      const values = ts.slice(closeIndex + 2).filter(t => t.depth === (source?.text.toUpperCase() === 'VALUES' ? 1 : 0))
      const operands: Token[][] = [[]]
      for (const token of values) { if (token.text.toUpperCase() === 'WHERE') break; if (token.text === ',') operands.push([]); else operands.at(-1)!.push(token) }
      const id = operands[columns.indexOf(member ? 'user_id' : 'id')]
      if (!open || open.text !== '(' || !id || id.length !== 1) throw new UnsupportedAtomicOperation('Policy INSERT requires explicit columns and id')
      guard.id = operand(id[0], bindings)
      if (!domain) {
        if (memberManagement !== 'create' && columns.some(field => field === 'role' || protectedFields.has(field))) throw new ApiError(403, 'field_forbidden')
        if (memberManagement !== 'create' && guard.id === actorAccountId(scope) && columns.some(field => protectedFields.has(field))) throw new ApiError(403, 'field_forbidden')
        return original
      }
      if (protect && columns.some(field => protectedFields.has(field))) throw new ApiError(403, 'field_forbidden')
    } else throw new UnsupportedAtomicOperation('Unsupported policy mutation')
    return { ...statement, policyGuard: guard }
  }) })) }
}
function rowKey(guard: WriteGuard): string {
  const table = quote(guard.entity)
  return guard.entity === 'memberships' ? `json_array(${table}.user_id,${table}.organization_id)` : `${table}.id`
}
/** Internal compiler-generated assertions. IDs are captured before each UPDATE/DELETE,
 * so arbitrary bulk predicates and post-image moves cannot evade the check. */
export function policyCapture(guard: WriteGuard, runId: string, index: number): SqlStatement[] {
  if (!guard.where) return []
  const prefix = `policy_${index}:`
  return [{ sql: `INSERT INTO atomic_assert (run_id,rule,step,ok,policy_ok,actor_ok) SELECT ?,? || ${rowKey(guard)},-(${(index + 1) * 1000000}+ROW_NUMBER() OVER ()),1,CASE WHEN (${guard.filter.sql}) THEN 1 ELSE 0 END,${guard.protected ? `CASE WHEN (${guard.protected.sql}) THEN 1 ELSE 0 END` : '1'} FROM ${quote(guard.entity)} WHERE ${guard.where.sql}`,
    bindings: [runId, prefix, ...(guard.filter.bindings ?? []), ...(guard.protected?.bindings ?? []), ...(guard.where.bindings ?? [])] }]
}
export function policyMutation(statement: GuardedStatement, guard: WriteGuard, runId: string, index: number): SqlStatement {
  if (!guard.mutation) return statement
  const prefix = `policy_${index}:`
  return { sql: `${guard.mutation.sql} WHERE EXISTS(SELECT 1 FROM atomic_assert AS captured WHERE captured.run_id=? AND substr(captured.rule,1,?)=? AND ${rowKey(guard)}=substr(captured.rule,?)) AND (${guard.filter.sql})`,
    bindings: [...(guard.mutation.bindings ?? []), runId, prefix.length, prefix, prefix.length + 1, ...(guard.filter.bindings ?? [])] }
}
export function policyAssertion(guard: WriteGuard, runId: string, index: number): SqlStatement {
  const table = quote(guard.entity); const prefix = `policy_${index}:`
  if (guard.operation === 'INSERT') return { sql: `SELECT EXISTS(SELECT 1 FROM ${table} WHERE id=? AND ${guard.filter.sql})`, bindings: [guard.id!, ...(guard.filter.bindings ?? [])] }
  const exists = `EXISTS(SELECT 1 FROM ${table} WHERE ${rowKey(guard)}=substr(captured.rule,?)${guard.operation === 'DELETE' ? '' : ` AND ${guard.filter.sql}`})`
  return { sql: `SELECT ${guard.requireRow ? 'EXISTS(SELECT 1 FROM atomic_assert WHERE run_id=? AND substr(rule,1,?)=?) AND ' : ''}NOT EXISTS(SELECT 1 FROM atomic_assert AS captured WHERE run_id=? AND substr(rule,1,?)=? AND ${guard.operation === 'DELETE' ? '' : 'NOT '}${exists})`,
    bindings: [...(guard.requireRow ? [runId, prefix.length, prefix] : []), runId, prefix.length, prefix, prefix.length + 1, ...(guard.operation === 'DELETE' ? [] : guard.filter.bindings ?? [])] }
}
