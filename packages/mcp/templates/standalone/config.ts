import { defineConfig, bindSchemaLock, bindOpenApi } from '@workbasehq/core/schema'
import worker from './schema/worker'
import access from './access'
import lock from './schema.lock.json'
import spec from './openapi.json'

// The literal loader supports generation before the imported artifacts exist.
export default bindOpenApi(bindSchemaLock(defineConfig({
  id: '{{INSTANCE_ID}}', displayName: {{INSTANCE_DISPLAY_NAME}},
  // The literal model is loadable before executable login plugins are composed.
  interactive: false, registration: 'open', languages: ['en'],
  roles: ['admin', 'staff'], organizationOwnerRole: 'admin',
  entities: { worker }, access,
}), lock), spec)
