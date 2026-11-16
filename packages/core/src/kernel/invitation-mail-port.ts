import type { InstanceConfig } from '../config'
import type { RuntimeEnv } from '../types'
import type { GuardedStatement } from '../execution/types'

export interface InvitationMailOptions {
  inviterId: string; role: string; expiresAt: string; kind: 'invite' | 'reminder'
  /** Bind delivery to the exact committed invitation, plus the caller's live row guard. */
  invitationId?: string
  eligible?: () => Promise<boolean>
}
export interface InvitationDeliveryStatus {
  status: string; attempts: number; sent_at: string | null; error: string | null
}
/** Members owns rendering and delivered-email credentials; core only orchestrates. */
export interface InvitationMailPort {
  prepare(env: RuntimeEnv, config: InstanceConfig, outboxId: string, organizationId: string, recipient: string, link: string,
    options: InvitationMailOptions): Promise<{
      intent(expiresAt: string): GuardedStatement
      deliver(): Promise<void>
    }>
  status(env: RuntimeEnv, config: InstanceConfig, outboxId: string | null): Promise<InvitationDeliveryStatus>
}
