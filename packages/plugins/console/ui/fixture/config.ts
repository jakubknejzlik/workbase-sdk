import { defineConfig, bindSchemaLock } from '@workbasehq/core/schema'
import worker from './schema/worker'
import lock from './schema.lock.json'
export default bindSchemaLock(defineConfig({ id: 'dictionary_fixture', roles: ['admin'], organizationOwnerRole: 'admin', languages: ['cs', 'en'], entities: { worker } }), lock)
