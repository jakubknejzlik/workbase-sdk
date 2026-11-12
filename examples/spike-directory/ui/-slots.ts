import { defineSlot, defineSlots, defineUI, p } from '@workbasehq/ui-v3'
import schema from '../schema'
import { Access, AccessBadge, Invite } from './-components/Access'

const { field } = defineUI(schema, 'workers', {})
export default defineSlots({
  access: defineSlot({
    modes: ['record'],
    props: { field: field('userLink'), allowInvite: p.boolean({ default: true }), allowRevoke: p.boolean() },
    render: ({ record, props }) => Access({ user: record[props.field], ...props }),
  }),
  accessBadge: defineSlot({
    modes: ['record', 'row'], props: { field: field('userLink') },
    render: ({ record, props }) => AccessBadge({ user: record[props.field] }),
  }),
  invite: defineSlot({
    modes: ['form'], props: { field: field('userLink'), when: p.when() },
    render: ({ record, props }) => Invite({ user: record[props.field] }),
  }),
})
