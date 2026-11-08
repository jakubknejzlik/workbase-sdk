import { api } from './client'

export interface InboxInvitation {
  id: string; organization: { id: string; name: string | null }; inviter: { display_name: string | null }
  role: string; expires_at: string; navigation_target: string
}
export interface InvitationInbox { data: InboxInvitation[]; next: string }
/** P8 recipient projection contains opaque IDs, never invitation credentials. */
export const invitationInboxOptions = {
  queryKey: ['invitation-inbox'], queryFn: () => api<InvitationInbox>('/me/invitations'), staleTime: 0, gcTime: 0,
}
export function invitationTarget(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\/invitation\?id=[A-Za-z0-9_-]+$/.test(value)) return
  return value
}
