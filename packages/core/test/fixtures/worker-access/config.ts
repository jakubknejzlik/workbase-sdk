import { defineConfig, bindSchemaLock, bindOpenApi } from '@workbasehq/core/schema'
import worker from './schema/worker'
import access from './access'
import lock from './schema.lock.json'
import spec from './openapi.json'
// Literal loader fixture for the same worker/account policy as worker-access.ts.
export default bindOpenApi(bindSchemaLock(defineConfig({
  id: 'worker_access', interactive: false, languages: ['en'],
  roles: ['admin', 'staff'], organizationOwnerRole: 'admin', entities: { worker }, access,
}), lock), spec)
