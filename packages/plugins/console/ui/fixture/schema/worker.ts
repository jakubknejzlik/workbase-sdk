import { defineEntity, accountLink } from '@workbasehq/core/schema'
export default defineEntity({ displayField: 'name', fields: {
  name: { type: 'string', required: true },
  status: { type: 'enum', values: ['active', 'off'] },
  user: accountLink(),
  locked: { type: 'string', readOnly: true },
} })
