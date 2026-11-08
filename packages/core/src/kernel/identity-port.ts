import type { InstanceConfig } from '../config'
import type { ResolvedActor, RuntimeEnv } from '../types'

export interface LocalUser { id: string; email: string; name?: string }
export interface ExternalIdentity { provider: string; issuer: string; subject: string }
export interface ExternalIdentityAssertion extends ExternalIdentity { email: string; emailVerified: boolean; firstName?: string; lastName?: string }
export interface ProfileSynchronization { method: string; maxLatencySeconds: number }
export interface ProfileNames { firstName: string; lastName: string }
export interface SelfProfile {
  id: string
  email: string
  firstName: string | null
  lastName: string | null
  displayName: string | null
  authority: { kind: 'local' | 'idp'; provider: string | null; synchronization: ProfileSynchronization | null }
  capabilities: { canEditNames: boolean; canEditEmail: false }
  completeness: { complete: boolean; missingFields: ('firstName' | 'lastName')[] }
  syncedAt: string | null
}
export interface IdentityLink {
  userId: string
  external: ExternalIdentityAssertion
  /** An explicit server-side confirmation; a JSON copy has no session provenance. */
  confirmation?: ResolvedActor
}
export interface IdentityPort {
  resolveUser(db: D1Database, userId: string): Promise<LocalUser>
  resolveExternalIdentity(db: D1Database, external: ExternalIdentity): Promise<LocalUser>
  linkExternalIdentity(env: RuntimeEnv, config: InstanceConfig, link: IdentityLink): Promise<void>
  readProfile(db: D1Database, config: InstanceConfig, userId: string): Promise<SelfProfile>
  /** Invitation hint: fills only an absent local profile, never a partial/existing or IdP profile. */
  prefillProfile(env: RuntimeEnv, config: InstanceConfig, userId: string, names: ProfileNames): Promise<void>
  updateProfile(env: RuntimeEnv, config: InstanceConfig, userId: string, names: ProfileNames): Promise<SelfProfile>
  /** Trusted login adapter only, after credential verification and external mapping resolution. */
  syncProfile(env: RuntimeEnv, config: InstanceConfig, external: ExternalIdentity, names: ProfileNames): Promise<void>
}
