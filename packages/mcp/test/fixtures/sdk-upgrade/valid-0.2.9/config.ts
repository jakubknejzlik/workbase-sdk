import { defineInstance } from '@workbasehq/core/config'
import { permissions } from '@workbasehq/plugins/permissions'

export default defineInstance({
  id: 'sdk_upgrade_fixture', displayName: 'SDK upgrade fixture', revision: 1,
  interactive: false,
  plugins: [permissions({ roles: ['owner', 'viewer'], ownerRole: 'owner' })],
  entities: { notes: { displayField: 'title', fields: { title: { type: 'string', required: true } } } },
  permissions: { owner: { notes: ['read', 'create', 'update', 'delete'] }, viewer: { notes: ['read'] } },
  policies: { notes: { owner: 'all', viewer: 'all' } },
})
