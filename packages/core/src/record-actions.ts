import { commandPreflight } from './commands'
import type { EffectiveAccessPolicy } from './access'
import { ApiError } from './errors'
import { kernelFor } from './kernel/registry'
import { rolePolicyFilter } from './policies'
import { writeFilter } from './execution/policies'
import type { SqlStatement } from './execution/types'
import type { InstanceConfig } from './config'
import type { Scope } from './types'
import { quote } from './migrations/schema'

const bindings = new WeakMap<EffectiveAccessPolicy, InstanceConfig>()
export function bindActionPolicy(policy: EffectiveAccessPolicy, config: InstanceConfig) { bindings.set(policy, config) }

export type ActionState = { enabled: true } | { enabled: false; reason: string }
/** One SQL definition shared by detail availability and the atomic dispatcher.
 * False/NULL conditions both disable; CASE preserves authored reason order.
 */
export function actionGuardSql(policy: EffectiveAccessPolicy, scope: Scope, entity: string, name: string, denial: 'omit' | 'throw' = 'omit') {
  const config = bindings.get(policy)!
  const kernel = kernelFor(config)
  const action = policy.actions.find(action => action.entity === entity && action.name === name)
  if (!action) return undefined
  const operation = kernel.commands.get(action.command)
  if (!operation) return undefined
  try {
    commandPreflight(config, scope, operation)
    kernel.atomicPermission(scope, operation)
  }
  catch (error) { if (denial === 'omit' && error instanceof ApiError && [403, 405].includes(error.status)) return undefined; throw error }
  if (action.dependencies.some(path => {
    const [target, field] = path.split('.')
    return !kernel.fieldMask(target, scope).includes(field)
  })) return undefined
  if ('system' in operation.permission) return undefined
  const read = writeFilter(kernel, scope, entity)
  const write = writeFilter(kernel, scope, entity, entity, operation.permission.operation)
  const conditions = action.conditions.map(condition => ({ ...condition,
    ...writeFilter(kernel, scope, entity, entity, 'read', rolePolicyFilter(config, entity, scope, scope.role, { where: condition.when })),
  }))
  const allowed: SqlStatement = { sql: [read, write, ...conditions].map(part => `(${part.sql})`).join(' AND '), bindings: [read, write, ...conditions].flatMap(part => [...(part.bindings ?? [])]) }
  const reason: SqlStatement = { sql: `CASE ${conditions.map(part => `WHEN NOT COALESCE((${part.sql}),0) THEN ?`).join(' ')} ELSE NULL END`,
    bindings: conditions.flatMap(part => [...(part.bindings ?? []), part.reason]) }
  // A command write filter can narrow rows even without an authored condition.
  // Its denial is unavailable, with a stable SDK key rather than a predicate leak.
  const state: SqlStatement = { sql: conditions.length ? reason.sql : 'NULL', bindings: conditions.length ? reason.bindings : [] }
  return { action, operation, read, allowed, state }
}
export async function recordActions(config: InstanceConfig, scope: Scope, db: D1Database, entity: string, id: string): Promise<Record<string, ActionState>> {
  const policy = config.effectiveAccess!
  const entries: [string, ActionState][] = []
  for (const action of policy.actions.filter(action => action.entity === entity)) {
    const guard = actionGuardSql(policy, scope, entity, action.name)
    if (!guard) continue
    const row = await db.prepare(`SELECT COALESCE((${guard.allowed.sql}),0) AS enabled, ${guard.state.sql} AS reason FROM ${quote(entity)} WHERE id=? AND (${guard.read.sql})`)
      .bind(...(guard.allowed.bindings ?? []), ...(guard.state.bindings ?? []), id, ...(guard.read.bindings ?? [])).first<{ enabled: number; reason: string | null }>()
    if (row) entries.push([action.name, row.enabled ? { enabled: true } : { enabled: false, reason: row.reason ?? 'sdk.action_unavailable' }])
  }
  return Object.fromEntries(entries)
}
