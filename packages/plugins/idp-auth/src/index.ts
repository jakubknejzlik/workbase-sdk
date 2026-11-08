import type { ExternalIdentityAssertion } from '../../../core/src/kernel/identity-port'

/** An adapter must verify its credential before returning an external assertion. */
export interface IdpAdapter {
  readonly id: string
  readonly synchronization: { method: string; maxLatencySeconds: number }
  authenticate(request: Request): Promise<ExternalIdentityAssertion | null>
  isActive(request: Request, identity: ExternalIdentityAssertion): Promise<boolean>
}
