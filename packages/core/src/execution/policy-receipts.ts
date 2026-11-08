import { isBuiltinPlugin } from '../kernel/builtin-source'
import { ApiError } from '../errors'
import { requestHash } from '../idempotency'
import type { InstanceConfig } from '../config'
import type { Scope } from '../types'
import type { KernelRegistry } from '../kernel/registry'
import { actorPolicyIdentity } from '../policies'
import { quote } from '../migrations/schema'
import { writeFilter, writeGuard } from './policies'
import type { AtomicReader, AtomicResult, AtomicRule, SqlStatement, SqlValue } from './types'

export function needsPolicyReceipt(kernel: KernelRegistry) {
  return !!kernel.config.account || Object.values(kernel.config.policies).some(roles => Object.values(roles).some(policy => typeof policy === 'object' && Object.keys(policy.where).length)) || kernel.plugins.some(plugin => plugin.tableFilter && !(isBuiltinPlugin(plugin) && plugin.policyInConfig === true))
}
export const receiptIdentity = (config: InstanceConfig, scope: Scope) => requestHash('policy-receipt', actorPolicyIdentity(config, scope))
/** Capture affected IDs while assertion rows still exist, before final post-image checks.
 * Receipt metadata is adapter-private and is stripped before returning an AtomicResult. */
export function receiptExpression(config: InstanceConfig, rules: readonly AtomicRule[], runId: string, result: AtomicResult, identity: string): SqlStatement {
  const parts: string[] = []; const bindings: SqlValue[] = [JSON.stringify(result), identity]; let index = 0
  for (const rule of rules) for (const statement of rule.statements) {
    const guard = writeGuard(statement); const prefix = `policy_${guard ? index++ : -1}:`
    if (!guard || !config.entities[guard.entity] || guard.operation === 'DELETE') continue
    if (guard.where) {
      parts.push('SELECT ? AS entity,substr(rule,?) AS id FROM atomic_assert WHERE run_id=? AND substr(rule,1,?)=?')
      bindings.push(guard.entity, prefix.length + 1, runId, prefix.length, prefix)
    } else {
      parts.push('SELECT ? AS entity,? AS id'); bindings.push(guard.entity, guard.id!)
    }
  }
  const rows = parts.length ? `(SELECT json_group_array(json_object('entity',entity,'id',id)) FROM (${parts.join(' UNION ALL ')}))` : "'[]'"
  return { sql: `json_set(?, '$.__workbase_policy', json_object('actor',?, 'rows',json(${rows})))`, bindings }
}
export async function authorizeReplay(kernel: KernelRegistry, scope: Scope, reader: AtomicReader, serialized: string, identity?: string): Promise<AtomicResult> {
  const { __workbase_policy: receipt, ...result } = JSON.parse(serialized)
  if (identity) {
    if (!receipt || receipt.actor !== identity) throw new ApiError(403, 'policy_violation')
    await authorizeReceiptRows(kernel, scope, reader, receipt.rows)
  }
  return result as AtomicResult
}
/** Workflow readers use their own live row policy, independently of the effect's initiating actor. */
export async function authorizeReceiptRows(kernel: KernelRegistry, scope: Scope, reader: AtomicReader, rows: unknown, read = false) {
  if (!Array.isArray(rows)) throw new ApiError(403, 'policy_violation')
  for (const row of rows) {
    if (!row || !Object.hasOwn(kernel.config.entities, row.entity) || typeof row.id !== 'string') throw new ApiError(403, 'policy_violation')
    if (read && !kernel.can(scope, row.entity, 'read')) throw new ApiError(403, 'policy_violation')
    const filter = writeFilter(kernel, scope, row.entity)
    const visible = await reader.first<{ ok: number }>({ sql: `SELECT EXISTS(SELECT 1 FROM ${quote(row.entity)} WHERE id=? AND (${filter.sql})) AS ok`, bindings: [row.id, ...(filter.bindings ?? [])] })
    if (!visible?.ok) throw new ApiError(403, 'policy_violation')
  }
}
