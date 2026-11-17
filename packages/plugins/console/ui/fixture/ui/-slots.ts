import { defineSlots, p } from '@workbasehq/plugins/console/ui'
import FieldValue from './-components/FieldValue'
export default defineSlots({ fieldValue: { contexts: ['record', 'form', 'row'], props: { value: p.field('userLink') }, component: FieldValue } })
