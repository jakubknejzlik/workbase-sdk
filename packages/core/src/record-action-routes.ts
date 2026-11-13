import { readRecord } from './record-read'
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
    z.strictObject({}).parse(await c.req.json())
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
      const result = await executeAtomic(operation, { id }, coreExecutionContext(config, scope, guarded, reader))
      return c.json(result.body, result.status as any)
    } catch (error) {
      // Prepare/planning errors must not outlive the record's visibility.
      await readRecord(config, scope, env, entity, id)
      if (!(error instanceof RuleFailed)) throw error
      // Diagnosis is read-only and runs only after atomic rollback. It cannot
      // authorize a commit; hidden rows have precisely GET's error body.
      const state = await reader.first<{ ok: number; reason: string | null }>(diagnose)
      if (!state) throw new ApiError(404, 'not_found')
      if (!state.ok) return c.json({ error: 'action_unavailable', reason: state.reason ?? 'sdk.action_unavailable' }, 409)
      throw error
    }
  })
}
