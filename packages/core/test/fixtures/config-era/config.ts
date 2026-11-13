import { defineConfig } from '@workbasehq/core/schema'
import worker from './schema/worker'
import access from './access'

export default defineConfig({
  id: 'probe', interactive: false, languages: ['en'],
  roles: ['admin', 'staff'], organizationOwnerRole: 'admin', entities: { worker }, access,
})
