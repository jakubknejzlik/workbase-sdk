import { api } from './client'

export interface InvitationSummary {
  id: string
  target?: { entity: string; row: string }
  organization: { id: string; name: string | null }
  inviter: { display_name: string | null }
  role: string; expires_at: string
  state: 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired'
  account_match: boolean | null
}
export interface InvitationPreview extends InvitationSummary {
  navigation_target: string; return_to: string; profile_complete: boolean
  next: 'terminal' | 'preview' | 'profile'
  actions: ('accept' | 'decline')[]
}
export interface AcceptedInvitation {
  id: string; state: 'accepted'; replayed: boolean
  organization_id: string; role: string; entry_target: string
}
export interface DeclinedInvitation { id: string; state: 'declined'; replayed: boolean }
export type InvitationSelector = { token: string } | { id: string }
const endpoint = (selector: InvitationSelector, action: string) => 'token' in selector
  ? `/invitations/${action}` : `/invitations/${encodeURIComponent(selector.id)}/${action}`
const body = (selector: InvitationSelector) => 'token' in selector ? { token: selector.token } : {}
export const invitationClient = {
  preview: (selector: InvitationSelector) => api<InvitationSummary>(endpoint(selector, 'token' in selector ? 'preflight' : 'preview'), { method: 'token' in selector ? 'POST' : 'GET', body: body(selector), redirect401: false }),
  resolve: (selector: InvitationSelector) => api<InvitationPreview>(endpoint(selector, 'resolve'), { method: 'POST', body: body(selector), redirect401: false }),
  // Anonymous acceptance establishes a session and returns a preview, without membership.
  accept: (selector: InvitationSelector) => api<InvitationPreview | AcceptedInvitation>(endpoint(selector, 'accept'), { method: 'POST', body: body(selector), redirect401: false }),
  decline: (selector: InvitationSelector) => api<DeclinedInvitation>(endpoint(selector, 'decline'), { method: 'POST', body: body(selector), redirect401: false }),
  inbox: () => api<{ data: (InvitationSummary & { navigation_target: string })[]; next: string }>('/me/invitations', { redirect401: false }),
}
