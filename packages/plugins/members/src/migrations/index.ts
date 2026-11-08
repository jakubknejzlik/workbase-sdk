import scopes from './001-scopes'
import pendingInvitations from './002-pending-invitations'
import recipients from './003-recipients'

// Applied in this order; never edit or reorder existing migrations, only append.
export const migrations = [
  scopes,
  pendingInvitations,
  recipients,
]
