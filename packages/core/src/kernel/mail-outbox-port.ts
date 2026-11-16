import type { GuardedStatement } from '../execution/types'
import type { InstanceConfig } from '../config'
import type { RuntimeEnv } from '../types'

/** Templates and credential eligibility belong to the calling plugin. */
export interface MailIntent {
  id: string; organizationId: string | null; recipient: string; subject: string
  body: string; text: string; html: string; expiresAt: string
  /** Caller-owned display name; the shared configured mailbox remains the sender. */
  senderName?: string
}
export interface MailStatus {
  id: string; delivery_status: 'pending' | 'sending' | 'sent' | 'failed'
  attempts: number; sent_at: string | null; last_error: string | null
}
/** Runtime-only finalization; returned credentials go directly to the transport. */
export type MailDeliveryRenderer = (message: { body: string; text: string; html: string }) => Promise<{ text: string; html: string; subject?: string }>
export interface MailOutboxPort {
  /** Include this statement in the caller's transaction; guard preserves mutation chaining. */
  intent(message: MailIntent, guard?: string): GuardedStatement
  status(db: D1Database, id: string): Promise<MailStatus | null>
  /** Caller must revalidate the live credential, scope and operation before every attempt. */
  deliver(env: RuntimeEnv, config: InstanceConfig, id: string, eligible: () => Promise<boolean>, render?: MailDeliveryRenderer): Promise<void>
  retry(env: RuntimeEnv, config: InstanceConfig, id: string, eligible: () => Promise<boolean>, render?: MailDeliveryRenderer): Promise<void>
}
