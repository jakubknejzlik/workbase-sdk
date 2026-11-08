import { defineInstance, organizationActions } from '../../../src/config'
import { createIdentity } from '@workbasehq/plugins/identity'
import { createLocalAuth } from '@workbasehq/plugins/local-auth'
import { permissions } from '@workbasehq/plugins/permissions'
import { createMembers } from '@workbasehq/plugins/members'
import { createOrganizations } from '@workbasehq/plugins/organizations'
import { machineCredentials } from '@workbasehq/plugins/machine-credentials'
import { mailOutbox } from '@workbasehq/plugins/mail-outbox'
import { consoleUI } from '@workbasehq/plugins/console'
import { audit } from '@workbasehq/plugins/audit'
import policyGraph from '../policy-graph/config'

const roles = ['administrator', 'reviewer', 'operator', 'coordinator', 'team_user', 'unknown']
// Account assignments and a non-owner management role, with organization creation disabled.
const accounts = defineInstance({
  ...policyGraph, id: 'accounts', displayName: 'Accounts', registration: 'open', revision: 2,
  roles, organizationOwnerRole: 'administrator', organizationPermissions: { administrator: [...organizationActions] },
  policies: Object.fromEntries(Object.entries(policyGraph.policies).map(([entity, policies]) => [entity, { ...policies, unknown: 'none' as const }])),
  account: { entity: 'users', managedBy: ['administrator'], assignments: ['role', 'team_id', 'assignable_to_job'] },
  plugins: [createIdentity(), permissions({ roles, ownerRole: 'administrator' }), createMembers(), createOrganizations({ allowCreate: false }), createLocalAuth({ methods: ['magic-link'] }), machineCredentials(), mailOutbox(), consoleUI(), audit()],
})
export default defineInstance(accounts)
