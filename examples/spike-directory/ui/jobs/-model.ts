import { defineUI } from '@workbasehq/ui-v3'
import schema from '../../schema'
export const { layout, list, section, columns, related } = defineUI(schema, 'jobs', {})
