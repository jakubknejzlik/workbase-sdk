import type { AuditEvent } from '../audit-event'
import type { RuntimeEnv } from '../types'

export interface AuditOutboxRow { event_id: string; organization_id: string; payload: string }
export interface AuditSink { insert(event: AuditEvent): Promise<number | void> }
export interface AuditRelayOptions {
  sweep?: boolean; sink?: AuditSink; now?: number; failBeforeSinkInsert?: boolean; failAfterSinkInsert?: boolean
}
export interface AuditPort {
  deliver(env: RuntimeEnv, row: AuditOutboxRow, options?: AuditRelayOptions): Promise<void>
  relay(env: RuntimeEnv, options?: AuditRelayOptions): Promise<{ delivered: number; errors: number }>
}
