import { readRecord } from './record-read'
import { isAccountAccessCommand } from './worker-access-actions'
import { z } from 'zod'
import { ApiError } from './errors'
import type { InstanceConfig } from './config'
import type { App, RuntimeEnv } from './types'
import { kernelFor } from './kernel/registry'
import { actionGuardSql } from './record-actions'
import { quote } from './migrations/schema'
import { executeAtomic } from './execution/atomic'
import { coreExecutionContext } from './execution/context'
import { D1AtomicReader, D1AtomicStore } from './execution/d1'
import { RuleFailed } from './execution/errors'
import type { AtomicStore, SqlStatement } from './execution/types'

function actionInputKeys(schema: any): string[] {
  // Inspect input-side wrappers structurally, without executing transforms or
  // relying on Zod constructor identity across module realms.
  for (let depth = 0; schema && depth < 16; depth++) {
    if (schema.shape) return Object.keys(schema.shape)
    if (schema.in) schema = schema.in
    else if (typeof schema.unwrap === 'function') schema = schema.unwrap()
    else break
  }
  return []
}

export function recordActionRoutes(app: App, config: InstanceConfig, env: RuntimeEnv) {
  if (config.baseline !== 'workbase-sdk') return
  const kernel = kernelFor(config)
  app.post('/api/:entity/:id/actions/:name', async c => {
    const entity = c.req.param('entity'), id = c.req.param('id'), name = c.req.param('name')
    const scope = c.get('scope'), policy = config.effectiveAccess!
    // Establish GET's complete read authority before any ID-dependent callback.
    await readRecord(config, scope, env, entity, id)
    const action = policy.actions.find(action => action.entity === entity && action.name === name)
    const operation = action && kernel.commands.get(action.command)
    if (!action || !operation) throw new ApiError(404, 'not_found')
    const guard = actionGuardSql(policy, scope, entity, name, 'throw')
    if (!guard) throw new ApiError(404, 'not_found')
    // Preserve every JSON key for strict validation, including __proto__.
    const raw = await c.req.json()
    const accountAction = isAccountAccessCommand(config, action.command)
    // Invitation credentials are never selectors for a record action. Their
    // rejection is independent of whether a foreign credential exists.
    if (accountAction && raw && typeof raw === 'object' && ['token', 'invitation_id'].some(key => Object.hasOwn(raw, key))) throw new ApiError(404, 'not_found')
    // Validate the body keys here; executeAtomic validates values and applies
    // defaults/transforms exactly once through the command's input schema.
    // Shape access is structural so schemas from another Zod realm work too.
    const keys = actionInputKeys(operation.input).filter(key => !['id', 'rowId', 'role'].includes(key))
    const body = z.strictObject(Object.fromEntries(keys.map(key => [key, z.unknown().optional()]))).parse(raw)
    const input = { ...body, id }
    const diagnose: SqlStatement = {
      sql: `SELECT COALESCE((${guard.allowed.sql}),0) AS ok, ${guard.state.sql} AS reason FROM ${quote(entity)} WHERE id=? AND (${guard.read.sql})`,
      bindings: [...(guard.allowed.bindings ?? []), ...(guard.state.bindings ?? []), id, ...(guard.read.bindings ?? [])],
    }
    const store = new D1AtomicStore(env.DB, { env, config }), reader = new D1AtomicReader(env.DB)
    const guarded: AtomicStore = { run: plan => store.run({ ...plan, rules: [{ name: 'record_action', statements: [{
      // A no-op DML supplies changes() for the existing expectRows assertion.
      // It precedes every command write and rolls back with the whole batch.
      sql: `UPDATE ${quote(entity)} SET id=id WHERE id=? AND (${guard.allowed.sql})`,
      bindings: [id, ...(guard.allowed.bindings ?? [])], expectRows: 1, diagnose,
    }] }, ...plan.rules] }) }
    try {
      const result = await executeAtomic(operation, input, coreExecutionContext(config, scope, guarded, reader))
      if (accountAction && name === 'invite') c.header('Cache-Control', 'no-store')
      return c.json(result.body, result.status as any)
    } catch (error) {
      // Prepare/planning errors must not outlive the record's visibility.
      // Confirmed GET denials (403/404) conceal the command error; an inconclusive
      // recheck (e.g. D1 outage surfacing as query_invalid) is an opaque 5xx.
      try { await readRecord(config, scope, env, entity, id) }
      catch (recheck) {
        if (recheck instanceof ApiError && (recheck.status === 403 || recheck.status === 404)) throw recheck
        throw new Error('record action visibility recheck failed', { cause: { recheck, error } })
      }
      if (!(error instanceof RuleFailed) && !(isAccountAccessCommand(config, action.command) && /UNIQUE constraint failed/i.test(String(error)))) throw error
      // Diagnosis is read-only and runs only after atomic rollback. It cannot
      // authorize a commit; hidden rows have precisely GET's error body.
      const state = await reader.first<{ ok: number; reason: string | null }>(diagnose)
      if (!state) throw new ApiError(404, 'not_found')
      if (!state.ok) return c.json({ error: 'action_unavailable', reason: state.reason ?? 'sdk.action_unavailable' }, 409)
      if (!(error instanceof RuleFailed)) throw new ApiError(409, 'invitation_pending')
      throw error
    }
  })
}
