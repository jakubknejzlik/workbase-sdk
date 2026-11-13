import { defineEntity, accountLink } from '@workbasehq/core/schema'
export default defineEntity({
  fields: { name: { type: 'text', required: true }, user: accountLink() },
  access: { admin: 'deny', staff: 'deny' },
})
