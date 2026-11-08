import { defineInstance } from '@workbasehq/core/config'
import { createIdentity } from '@workbasehq/plugins/identity'
import { createMembers } from '@workbasehq/plugins/members'
import { createOrganizations } from '@workbasehq/plugins/organizations'
import { permissions } from '@workbasehq/plugins/permissions'
import { createLocalAuth } from '@workbasehq/plugins/local-auth'
import { machineCredentials } from '@workbasehq/plugins/machine-credentials'
import { mailOutbox } from '@workbasehq/plugins/mail-outbox'
import { audit } from '@workbasehq/plugins/audit'
import { consoleUI } from '@workbasehq/plugins/console'

export default defineInstance({
  id: '{{INSTANCE_ID}}', displayName: '{{INSTANCE_ID}}', revision: 1,
  registration: 'open', interactive: true,
  plugins: [createIdentity(), permissions({ roles: ['owner', 'viewer'], ownerRole: 'owner' }),
    createMembers(), createOrganizations({ allowCreate: true }), createLocalAuth({ methods: ['magic-link'] }),
    machineCredentials(), mailOutbox(), audit(), consoleUI()],
  entities: {},
  permissions: {},
  policies: {},
})
