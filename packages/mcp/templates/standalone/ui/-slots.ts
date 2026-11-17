import { defineSlots, p } from '@workbasehq/plugins/console/ui'
import { AccessCard } from '@workbasehq/plugins/console/ui/react'
export default defineSlots({ accessCard: {
  contexts: ['record'], props: { account: p.field('userLink'), access: p.access() }, component: AccessCard,
} })
