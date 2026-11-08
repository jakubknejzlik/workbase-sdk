import { publishCommittedEvents } from '../event-delivery'
import type { RuntimeEnv } from '../types'
import type { InstanceConfig } from '../config'
import { ApiError } from '../errors'
import type { AtomicReader, AtomicStore, RawOutcome, SqlStatement, StorePlan } from './types'
import { compile, readOnly } from './compiler'
import { RuleFailed } from './errors'

export class D1AtomicReader implements AtomicReader {
  constructor(private readonly db: D1Database) {}
  first<T>(query: SqlStatement): Promise<T | null> {
    readOnly(query)
    return this.db.prepare(query.sql).bind(...(query.bindings ?? [])).first<T>()
  }
}
export class D1AtomicStore implements AtomicStore {
  constructor(private readonly db: D1Database, private readonly delivery?: { env: RuntimeEnv; config: InstanceConfig }) {}
  async run(plan: StorePlan): Promise<RawOutcome> {
    const statements = compile(plan)
    let results: D1Result[]
    try {
      results = await this.db.batch(statements.map(s => this.db.prepare(s.sql).bind(...(s.bindings ?? []))))
    } catch (error) {
      if (/CHECK constraint failed: policy_ok\s*=\s*1/i.test(String(error))) throw new ApiError(403, 'policy_violation')
      if (/CHECK constraint failed: actor_ok\s*=\s*1/i.test(String(error))) throw new ApiError(403, 'field_forbidden')
      // The CHECK, not diagnosis, guarantees rollback. Another request may already
      // have changed the rolled-back state when these optional SELECTs run.
      if (!/CHECK constraint failed: (?:atomic_assert|ok\s*=\s*1)/i.test(String(error))) throw error
      const reader = new D1AtomicReader(this.db)
      for (const rule of plan.rules) for (const statement of rule.statements) {
        if (!statement.diagnose) continue
        try {
          const diagnosis = await reader.first<{ ok: number }>(statement.diagnose)
          if (!diagnosis?.ok) throw new RuleFailed(rule.name, statement.failureCode)
        } catch (diagnosisError) {
          if (diagnosisError instanceof RuleFailed) throw diagnosisError
          // Diagnostic failure cannot change the guaranteed atomic rejection.
        }
      }
      throw new RuleFailed('unknown')
    }
    if (this.delivery) await publishCommittedEvents(this.delivery.env, this.delivery.config,
      plan.rules.flatMap(rule => rule.statements.flatMap(statement => statement.outboxEvent ? [statement.outboxEvent] : [])))
    return { changes: results.map(r => r.meta.changes) }
  }
}
