import { useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from './client'
import { organizationOptions, fetchCapabilities } from './queries'

export const identityKinds = ['members', 'invitations', 'tokens'] as const
export type IdentityKind = typeof identityKinds[number]
export interface NavigationConfig {
  routes?: { id: string; icon?: string; order?: number }[]
  groups: { id: string; label: string; icon?: string; order?: number }[]
  items: { id: string; entity: string; label?: string; icon?: string; group?: string; order?: number; roles?: string[]; view?: string; hidden?: boolean }[]
}
export interface InstanceSchema { locale?: 'en' | 'cs'; instance: string; displayName?: string; roles: string[]; ui?: { defaultLanguage?: 'en' | 'cs'; navigation?: NavigationConfig } }
export interface Member { user_id: string; email: string; role: string; joined_at?: string; display_name?: string | null; last_administrator?: boolean; kind?: 'member'; actions?: string[] }
export interface Invitation { id: string; email: string; role: string; expires_at: string; accepted_at: string | null; revoked_at: string | null; declined_at?: string | null; expired_at?: string | null; created_at?: string; kind?: 'invitation'; inviter?: { display_name: string }; actions?: string[] }
export interface RoleOption { id: string; administrator: boolean }
export interface MembersView { data: (Member | Invitation)[]; role_options: RoleOption[]; default_role: string }
export interface Delivery { status: 'queued' | 'sending' | 'delivered' | 'failed' | 'not_requested'; attempts: number; sent_at: string | null; error: string | null }
export interface AgentToken { id: string; name: string; prefix: string; role: string; operations: string[] | null; expires_at: string; last_used_at: string | null; revoked_at: string | null }
export interface IdentityRows { members: Member; invitations: Invitation; tokens: AgentToken }
export interface CredentialInput { role: string; expires_at?: string }
export const identityRoot = (orgId: string) => `/orgs/${encodeURIComponent(orgId)}`
export const identityClient = {
  list: <K extends IdentityKind>(orgId: string, kind: K) => api<{ data: IdentityRows[K][] }>(`${identityRoot(orgId)}/${kind}`, { orgId }),
  combined: (orgId: string) => api<MembersView>(`${identityRoot(orgId)}/members?include=pending`, { orgId }),
  copyLink: (orgId: string, id: string) => api<{ accept_url: string }>(`${identityRoot(orgId)}/invitations/${encodeURIComponent(id)}/copy-link`, { orgId, method: 'POST' }),
  delivery: (orgId: string, id: string) => api<{ delivery: Delivery }>(`${identityRoot(orgId)}/invitations/${encodeURIComponent(id)}/delivery`, { orgId }),
  retryDelivery: (orgId: string, id: string) => api<{ delivery: Delivery }>(`${identityRoot(orgId)}/invitations/${encodeURIComponent(id)}/retry-delivery`, { orgId, method: 'POST' }),
  changeRole: (orgId: string, userId: string, role: string) => api(`${identityRoot(orgId)}/members/${encodeURIComponent(userId)}`, { orgId, method: 'PATCH', body: { role } }),
  removeMember: (orgId: string, userId: string) => api(`${identityRoot(orgId)}/members/${encodeURIComponent(userId)}`, { orgId, method: 'DELETE' }),
  leave: (orgId: string) => api(`${identityRoot(orgId)}/leave`, { orgId, method: 'POST' }),
  invite: (orgId: string, body: CredentialInput & { email: string }) => api<Omit<Invitation, 'accepted_at' | 'revoked_at'>>(`${identityRoot(orgId)}/invitations`, { orgId, method: 'POST', body }),
  resend: (orgId: string, id: string) => api<{ id: string } | { message: 'already_member' }>(`${identityRoot(orgId)}/invitations/${encodeURIComponent(id)}/resend`, { orgId, method: 'POST' }),
  revoke: (orgId: string, kind: 'invitations' | 'tokens', id: string) => api(`${identityRoot(orgId)}/${kind}/${encodeURIComponent(id)}`, { orgId, method: 'DELETE' }),
}
export const instanceOptions = { queryKey: ['instance'], queryFn: () => api<InstanceSchema>('/console-info'), staleTime: Infinity }
export const identityKey = (orgId: string, role?: string) => role === undefined ? ['workspace-identity', orgId] as const : ['workspace-identity', orgId, role] as const
/** Live scope preflight; endpoints recheck their action-specific grants. A write
 * refusal stays in its dialog and never implies membership loss. */
export function useIdentityAction(orgId: string) {
  const client = useQueryClient()
  return async <T,>(action: () => Promise<T>, grant: string): Promise<T> => {
    await client.fetchQuery({ ...organizationOptions(orgId), staleTime: 0 })
    {
      const requiredGrant = grant
      const caps = await client.fetchQuery({ queryKey: ['capabilities', orgId], queryFn: () => fetchCapabilities(client, orgId), staleTime: 0 })
      if (!caps.resources?.[requiredGrant]) throw new ApiError(403, 'permission_denied')
    }
    try { return await action() } finally { void client.invalidateQueries({ queryKey: ['capabilities', orgId] }) }
  }
}
