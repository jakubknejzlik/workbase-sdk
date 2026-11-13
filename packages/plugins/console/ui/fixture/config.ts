import { defineConfig } from '@workbasehq/core/schema'
import worker from './schema/worker'
export default defineConfig({ id: 'dictionary_fixture', revision: 1, roles: ['admin'], organizationOwnerRole: 'admin', languages: ['cs', 'en'], entities: { worker } })
