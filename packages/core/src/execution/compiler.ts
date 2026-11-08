import { writeGuard, policyCapture, policyAssertion, policyMutation } from './policies'
import type { AtomicPlan, StorePlan, SqlStatement } from './types'
import { UnsupportedAtomicOperation } from './errors'

function description(value: unknown): void {
  if (typeof value === 'function' || (value && typeof value === 'object' && 'then' in value)) throw new UnsupportedAtomicOperation('Plans must be synchronous descriptions')
  if (Array.isArray(value)) value.forEach(description)
  else if (value && typeof value === 'object') Object.values(value).forEach(description)
}
export function validatePlan(plan: AtomicPlan): void {
  description(plan)
  if (plan.remoteCall || plan.dependsOnPriorWrite) throw new UnsupportedAtomicOperation('Remote calls and JavaScript dependencies on writes require a workflow')
  if (plan.databases?.some(db => db !== 'primary') || (plan.databases?.length ?? 0) > 1) throw new UnsupportedAtomicOperation('An atomic plan targets exactly one database')
  if (!plan.rules?.length || !plan.rules.some(rule => rule.statements.length)) throw new UnsupportedAtomicOperation('An atomic plan needs SQL rules')
  if (plan.rules.some(rule => rule.statements.some(statement => 'policyGuard' in statement))) throw new UnsupportedAtomicOperation('Policy guard metadata is execution-owned')
}
export function readOnly(query: SqlStatement): void {
  // Deliberately narrow. WITH/PRAGMA and multi-statement SQL are not reader capabilities.
  if (!/^\s*SELECT\b/i.test(query.sql) || /;|--|\/\*/.test(query.sql)) throw new UnsupportedAtomicOperation('Preparation and diagnosis accept one SELECT only')
}
/** Assertions immediately follow their writes: changes() therefore refers to that write. */
export function compile(plan: StorePlan): SqlStatement[] {
  description(plan)
  const sql: SqlStatement[] = []
  const postImages: SqlStatement[] = []
  let step = 0
  let policyIndex = 0
  if (!plan.rules?.length || !plan.rules.some(rule => rule.statements.length)) throw new UnsupportedAtomicOperation('An atomic plan needs SQL rules')
  for (const rule of plan.rules) {
    if (!/^[a-z][a-z0-9_]*$/.test(rule.name)) throw new UnsupportedAtomicOperation('Invalid rule name')
    for (const statement of rule.statements) {
      if (statement.bindings?.some(value => value !== null && typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value)))) throw new UnsupportedAtomicOperation('SQL bindings must be values known before execution')
      if (statement.database && statement.database !== 'primary') throw new UnsupportedAtomicOperation('Cross-database statement')
      if (!/^\s*(INSERT|UPDATE|DELETE)\b/i.test(statement.sql) || /;|--|\/\*/.test(statement.sql) || /^\s*(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`\[]?atomic_assert\b/i.test(statement.sql)) throw new UnsupportedAtomicOperation('Rules accept one domain DML statement only')
      if (statement.expectRows !== undefined && statement.expectRows !== 1 && statement.expectRows !== '>=1') throw new UnsupportedAtomicOperation('Unsupported row expectation')
      if (statement.diagnose) readOnly(statement.diagnose)
      const guard = writeGuard(statement)
      // Adapter-owned unguarded statements must not shift receipt capture identities.
      const index = guard ? policyIndex++ : -1
      if (guard) sql.push(...policyCapture(guard, plan.runId, index))
      sql.push(guard ? policyMutation(statement, guard, plan.runId, index) : { sql: statement.sql, bindings: statement.bindings })
      if (statement.expectRows !== undefined) sql.push({
        sql: `INSERT INTO atomic_assert (run_id,rule,step,${guard && !statement.diagnose ? 'ok,policy_ok' : 'ok'}) VALUES (?,?,?,${guard && !statement.diagnose ? '1,' : ''}(SELECT changes()) ${statement.expectRows === 1 ? '=' : '>='} 1)`,
        bindings: [plan.runId, rule.name, step++],
      })
      if (guard) {
        const assertion = policyAssertion(guard, plan.runId, index)
        postImages.push({ sql: `INSERT INTO atomic_assert (run_id,rule,step,ok,policy_ok) VALUES (?,?,?,1,(${assertion.sql}))`, bindings: [plan.runId, 'policy_violation', step++, ...(assertion.bindings ?? [])] })
      }
    }
  }
  sql.push(...postImages)
  sql.push({ sql: 'DELETE FROM atomic_assert WHERE run_id=?', bindings: [plan.runId] })
  return sql
}
