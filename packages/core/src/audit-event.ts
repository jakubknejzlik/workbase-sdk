import type { InstanceConfig } from './config'
import { ulid } from './crypto'
import type { Actor, Scope } from './identity'
export interface AuditEvent {
  event_id: string; instance_id: string; organization_id: string; actor: Actor;
  operation: string; entity: string; entity_id: string; occurred_at: string;
  correlation_id: string; schema_version: number; changes: Record<string, unknown>;
  details?: Record<string, unknown>
}
function redact(value: unknown): unknown {
  if (typeof value === 'string' && /[A-Z0-9._%+-]+@[A-Z0-9.-]+/i.test(value)) return '[redacted]'
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !/password|token|salt|email|secret/i.test(k)).map(([k, v]) => [k, redact(v)]))
  return value
}
export function makeEvent(config: InstanceConfig, scope: Scope, operation: string, entity: string, id: string, before: Record<string, unknown> = {}, after: Record<string, unknown> = {}, details?: Record<string, unknown>): AuditEvent {
  const changes: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(config.entities[entity]?.fields ?? {})) {
    if (field.sensitive || /password|token|salt|email|secret/i.test(key)) continue
    if (JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)) changes[key] = { before: redact(before[key] ?? null), after: redact(after[key] ?? null) }
  }
  return { event_id: ulid(), instance_id: config.id, organization_id: scope.organizationId, actor: scope.actor, operation, entity, entity_id: id, occurred_at: new Date().toISOString(), correlation_id: scope.correlationId, schema_version: config.revision, changes, ...(details ? { details: redact(details) as Record<string, unknown> } : {}) }
}
