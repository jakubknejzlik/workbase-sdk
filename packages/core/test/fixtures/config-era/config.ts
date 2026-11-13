import { defineConfig, bindSchemaLock } from '@workbasehq/core/schema'
import worker from './schema/worker'
import access from './access'
import lock from './schema.lock.json'
export default bindSchemaLock(defineConfig({
  id: 'probe', interactive: false, languages: ['en'],
  roles: ['admin', 'staff'], organizationOwnerRole: 'admin', entities: { worker }, access,
}), lock)
