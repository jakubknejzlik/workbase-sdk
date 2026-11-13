import { scopeMiddleware } from '../../../core/src/authorization'
import { kernelFor } from '@workbasehq/core/kernel/registry'
import type { AuditEvent } from '../../../core/src/events'
import type { InstanceConfig } from '@workbasehq/core/config'
import type { App, RuntimeEnv } from '../../../core/src/types'
import { ApiError } from '../../../core/src/errors'
import { hasOwnerRole } from '@workbasehq/core/policies'
import { cursorSecret } from '../../../core/src/query/routes'
import { auditPrefix, segment, timePrefixes, type AuditMetadata } from './keys'
import { decodePosition, encodePosition, type Position } from './cursor'
import { auditActorLabels } from '../../../core/src/audit'

// Includes descending timestamp-prefix traversal. Together with value reads,
// this stays below the 1,000 KV operation limit, including sparse histories.
export const auditListBudget = 315
const listPageSize = 90
const valueBudget = 600

export function auditRoutes(app: App, config: InstanceConfig, env: RuntimeEnv) {
  app.get('/audit/events', scopeMiddleware(env, config, kernelFor(config)), async c => {
    const scope = c.get('scope')
    if (!hasOwnerRole(scope, config)) throw new ApiError(403, 'owner_required')
    kernelFor(config).resourcePermission(scope, 'audit.read')
    let entity = c.req.query('entity')
    if (entity && !config.entities[entity] && config.entities[`${entity}s`]) entity += 's'
    const entityId = c.req.query('entity_id') || undefined
    // Retain entity_id-only reads: filter the organization activity index metadata.
    const dates = ['from', 'to'].map(key => {
      const value = c.req.query(key)
      if (!value) return undefined
      const date = new Date(value)
      if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 0 || date.getUTCFullYear() > 9999) throw new ApiError(400, 'invalid_date')
      return date.toISOString()
    })
    const paginated = c.req.query('limit') !== undefined || c.req.query('cursor') !== undefined
    const limit = paginated ? Number(c.req.query('limit') ?? '25') : 100
    if (!Number.isInteger(limit) || limit < 1 || (paginated && limit > 90)) throw new ApiError(400, 'invalid_limit')
    // Tenant and instance always come from the authenticated scope and config.
    const base = auditPrefix(scope.organizationId, config.id)
    const prefix = entity ? entityId ? `${base}e/${segment(entity)}/${segment(entityId)}/` : `${base}t/${segment(entity)}/` : `${base}all/`
    const ranges = timePrefixes(dates[0], dates[1]).reverse()
    const context = JSON.stringify([scope.organizationId, config.id, entity ?? null, entityId ?? null, ...dates, prefix])
    const secret = await cursorSecret(env)
    const cursor = c.req.query('cursor')
    let position: Position = cursor === undefined ? { range: 0, prefix: ranges[0] ?? '', cursor: '', after: '' } : await decodePosition(cursor, secret, context, ranges)
    const data: AuditEvent[] = []
    let next: string | null = null
    let listCalls = 0; let valueReads = 0; let valueBudgetHit = false
    const advance = () => {
      // Move to the preceding decimal subtree, then the preceding date range.
      let digits = position.prefix
      while (digits.length > ranges[position.range].length && digits.endsWith('0')) digits = digits.slice(0, -1)
      if (digits.length > ranges[position.range].length) position = { ...position, prefix: digits.slice(0, -1) + (Number(digits.at(-1)) - 1), cursor: '' }
      else position = { ...position, range: position.range + 1, prefix: ranges[position.range + 1] ?? '', cursor: '' }
    }
    while (position.range < ranges.length && listCalls < auditListBudget) {
      const page = await env.AUDIT_KV.list<AuditMetadata>({ prefix: prefix + position.prefix, limit: listPageSize, ...(position.cursor ? { cursor: position.cursor } : {}) })
      listCalls++
      // KV only lists ascending. Split crowded time prefixes newest-child first;
      // complete leaves fit in memory, while exact-millisecond ties use native
      // cursors in stable event-id order. Existing stored keys need no migration.
      if (!page.list_complete && page.keys.length && position.prefix.length < 17) {
        const digit = position.after && position.after.startsWith(position.prefix) ? position.after[position.prefix.length] : '9'
        position = { ...position, prefix: position.prefix + digit, cursor: '' }
        continue
      }
      const keys = [...page.keys].sort((a, b) => {
        const left = a.name.slice(prefix.length); const right = b.name.slice(prefix.length)
        return left.slice(0, 17) === right.slice(0, 17) ? (left < right ? -1 : left > right ? 1 : 0) : left > right ? -1 : 1
      })
      const matching = keys.filter(key => {
        const suffix = key.name.slice(prefix.length)
        if (position.after && (suffix.slice(0, 17) > position.after.slice(0, 17)
          || (suffix.slice(0, 17) === position.after.slice(0, 17) && suffix <= position.after))) return false
        const metadata = key.metadata
        return metadata && (!entity || metadata.entity === entity) && (!entityId || metadata.entity_id === entityId)
      })
      let inspected = 0
      while (inspected < matching.length) {
        if (valueReads === valueBudget) {
          valueBudgetHit = true
          if (paginated) next = await encodePosition(secret, context, position)
          break
        }
        // Read only the remaining page plus its lookahead, capped by both the
        // native page (90 keys) and the existing per-request value budget.
        const chunk = matching.slice(inspected, inspected + Math.min(valueBudget - valueReads, limit - data.length + (paginated ? 1 : 0)))
        valueReads += chunk.length; inspected += chunk.length
        const values = await env.AUDIT_KV.get<AuditEvent>(chunk.map(key => key.name), 'json')
        for (const key of chunk) {
          const suffix = key.name.slice(prefix.length)
          const event = values.get(key.name)
          if (!event) { position.after = suffix; continue } // An index may arrive before its value.
          if (data.length === limit) {
            next = await encodePosition(secret, context, position)
            break
          }
          data.push(event)
          position.after = suffix
        }
        if (next || (!paginated && data.length === limit)) break
      }
      if (next || valueBudgetHit) break
      if (page.list_complete) advance()
      else position = { ...position, cursor: page.cursor }
      if (!paginated && data.length === limit) break
    }
    // Position has advanced past every inspected key, including empty pages and
    // exhausted ranges. Budget exhaustion need not find a matching lookahead.
    if (paginated && !next && position.range < ranges.length) next = await encodePosition(secret, context, position)
    return c.json({ data: await auditActorLabels(env.DB, scope.organizationId, data), ...(paginated ? { next_cursor: next } : {}) })
  })
}
