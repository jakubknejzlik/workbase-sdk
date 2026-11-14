import { defineConfig, bindSchemaLock } from '@workbasehq/core/schema'
import worker from './schema/worker'
import access from './access'
import lock from './schema.lock.json'

export default bindSchemaLock(defineConfig({
  id: '{{INSTANCE_ID}}', displayName: '{{INSTANCE_ID}}',
  // The literal model is loadable before executable login plugins are composed.
  interactive: false, registration: 'open', languages: ['en'],
  roles: ['admin', 'staff'], organizationOwnerRole: 'admin',
  entities: { worker }, access,
}), lock)
