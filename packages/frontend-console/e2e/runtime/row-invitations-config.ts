import { defineInstance } from '@workbasehq/core/config'
import { createIdentity } from '@workbasehq/plugins/identity'
import { createLocalAuth } from '@workbasehq/plugins/local-auth'
import { createMembers } from '@workbasehq/plugins/members'
import { createOrganizations } from '@workbasehq/plugins/organizations'
import { permissions } from '@workbasehq/plugins/permissions'
import { consoleUI } from '@workbasehq/plugins/console'
import { mailOutbox } from '@workbasehq/plugins/mail-outbox'

export const rowConfig = defineInstance({ id: 'row_invitation_console', revision: 1, interactive: true,
  account: { entity: 'users' }, roles: ['owner', 'member'], locale: 'cs',
  plugins: [createIdentity(), createLocalAuth(), permissions({ roles: ['owner', 'member'] }), createMembers(), createOrganizations(), consoleUI(), mailOutbox()],
  entities: {
    users: { fields: { name: { type: 'string' } } },
    people: { displayField: 'name', fields: { name: { type: 'string' }, user: { type: 'ref', entity: 'users', userLink: true } }, relations: { account: { entity: 'users', field: 'user' } } },
    private_notes: { displayField: 'note', fields: { note: { type: 'string' } } },
  },
  permissions: { owner: { users: ['read', 'create'], people: ['read', 'create', 'update', 'delete'], private_notes: ['read', 'create'] }, member: { people: ['read'] } },
  organizationPermissions: { owner: ['invitations.create', 'invitations.read', 'invitations.revoke', 'members.read', 'members.remove'] },
  policies: { users: { owner: 'all', member: 'none' }, people: { owner: 'all', member: { where: { user: { eq: '$actor.id' } } } }, private_notes: { owner: 'all', member: 'none' } },
  enumLabels: { cs: { entity_people: 'Pracovníci', entity_users: 'Účty', entity_private_notes: 'Soukromé poznámky', field_name: 'Jméno' } },
  ui: { defaultLanguage: 'cs', entities: { people: { list: { columns: ['name'] } } } },
})
