import type { App, RuntimeEnv } from '../../../core/src/types'
import type { InstanceConfig } from '@workbasehq/core/config'
import { scopeMiddleware } from '../../../core/src/authorization'
import { kernelFor } from '@workbasehq/core/kernel/registry'
import { hasOwnerRole } from '@workbasehq/core/policies'
import { ApiError } from '../../../core/src/errors'

export function operationalRoutes(app: App, config: InstanceConfig, env: RuntimeEnv) {
  const kernel = kernelFor(config)
  app.get('/audit/operations', scopeMiddleware(env, config, kernel), async c => {
    const scope = c.get('scope')
    if (!hasOwnerRole(scope, config)) throw new ApiError(403, 'owner_required')
    kernel.resourcePermission(scope, 'audit.read')
    const source = c.req.query('source')
    if (source && !['workflow', 'webhook', 'mail', 'audit'].includes(source)) throw new ApiError(400, 'invalid_source')
    const sourceId = c.req.query('source_id')
    if (sourceId !== undefined && (!sourceId || sourceId.length > 200)) throw new ApiError(400, 'invalid_source_id')
    const limit = Number(c.req.query('limit') ?? 100)
    const offset = Number(c.req.query('offset') ?? 0)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw new ApiError(400, 'invalid_pagination')
    // One projection over existing stores. Bind the authenticated tenant into
    // every branch; source payload, body, actor credentials and URLs never enter it.
    const branches: string[] = []
    const bindings: (string | number)[] = []
    const history = (name: string, table: string, id: string, currentState: string) => {
      if (source && source !== name) return
      branches.push(`SELECT '${name}' AS source,t.organization_id,t.${id} AS source_id,NULL AS step_id,t.created_at,${currentState} AS current_state,
        json_extract(h.value,'$.occurred_at') AS occurred_at,json_extract(h.value,'$.state') AS state,
        json_extract(h.value,'$.error_code') AS error_code,json_extract(h.value,'$.attempts') AS attempts,0 AS compensation_attempts,
        h.key AS sequence
        FROM ${table} t,json_each(t.operational_history) h WHERE t.organization_id=?`)
      bindings.push(scope.organizationId)
    }
    history('webhook', 'webhook_deliveries', 'event_id', 't.state')
    history('audit', 'audit_outbox', 'event_id', "CASE WHEN t.delivered_at IS NULL THEN 'pending' ELSE 'delivered' END")
    if (kernel.plugins.some(plugin => plugin.name === 'mail-outbox')) history('mail', 'email_outbox', 'id', 't.delivery_status')
    if (!source || source === 'workflow') {
      branches.push(`SELECT 'workflow' AS source,a.organization_id,json_extract(a.payload,'$.details.run_id') AS source_id,
        json_extract(a.payload,'$.details.step_id') AS step_id,a.created_at,(SELECT status FROM workflow_runs WHERE id=json_extract(a.payload,'$.details.run_id') AND organization_id=a.organization_id) AS current_state,
        json_extract(a.payload,'$.occurred_at') AS occurred_at,json_extract(a.payload,'$.details.state') AS state,
        json_extract(a.payload,'$.details.code') AS error_code,json_extract(a.payload,'$.details.attempts') AS attempts,
        json_extract(a.payload,'$.details.compensation_attempts') AS compensation_attempts,a.event_id AS sequence
        FROM audit_outbox a WHERE a.organization_id=? AND json_extract(a.payload,'$.operation') IN ('workflow.step.failed','workflow.failed','workflow.needs_attention')`)
      bindings.push(scope.organizationId)
    }
    if (!branches.length) return c.json({ data: [], next_offset: null })
    if (sourceId) bindings.push(sourceId)
    const result = await env.DB.prepare(`SELECT *,max(0,cast((julianday('now')-julianday(created_at))*86400 AS INTEGER)) AS age_seconds
      FROM (${branches.join(' UNION ALL ')}) ${sourceId ? 'WHERE source_id=?' : ''} ORDER BY occurred_at DESC,source,source_id,sequence LIMIT ? OFFSET ?`)
      .bind(...bindings, limit + 1, offset).all<Record<string, unknown>>()
    const data = result.results.slice(0, limit).map(({ sequence: _sequence, ...row }) => ({ instance_id: config.id, ...row }))
    return c.json({ data, next_offset: result.results.length > limit ? offset + limit : null })
  })
}
