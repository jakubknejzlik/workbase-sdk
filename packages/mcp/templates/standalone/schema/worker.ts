import { defineEntity, accountLink } from '@workbasehq/core/schema'
export default defineEntity({
  fields: { name: { type: 'text', required: true }, user: accountLink() },
  access: {
    admin: { read: 'allow', create: 'allow', update: 'allow', delete: 'allow' },
    staff: { read: { where: { user: { eq: '$actor.id' } } }, create: 'deny', update: 'deny', delete: 'deny' },
  },
})
