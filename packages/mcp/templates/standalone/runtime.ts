import { createIdentity } from '@workbasehq/plugins/identity'
import { createMembers } from '@workbasehq/plugins/members'
import { createOrganizations } from '@workbasehq/plugins/organizations'
import { permissions } from '@workbasehq/plugins/permissions'
import { createLocalAuth } from '@workbasehq/plugins/local-auth'
import { machineCredentials } from '@workbasehq/plugins/machine-credentials'
import { mailOutbox } from '@workbasehq/plugins/mail-outbox'
import { audit } from '@workbasehq/plugins/audit'
import { consoleUI } from '@workbasehq/plugins/console'
import config from './config'

// Executable plugin composition stays outside the literal config loader boundary.
export default { ...config, interactive: true, plugins: [
  createIdentity(), permissions({ roles: ['admin', 'staff'], ownerRole: 'admin' }),
  createMembers(), createOrganizations({ allowCreate: true }), createLocalAuth({ methods: ['magic-link'] }),
  machineCredentials(), mailOutbox(), audit(), consoleUI(),
] }
