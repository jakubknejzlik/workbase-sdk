/** Members status discloses account identity through workspace members.read and the source link field grant.
 * Storage currently holds one scalar link. The inconsistency result is reserved for
 * adapters/legacy sources; invitation history is never treated as linked accounts. */
export interface RowAccessStatus {
  state: 'invited' | 'expired' | 'signed_in' | 'no_account'
  inconsistency: 'multiple_linked_accounts' | null
  linked_accounts?: { id: string; label?: string }[]
  can_invite: boolean
  can_cancel: boolean
  invitation?: { id: string; email: string; expires_at: string }
}
