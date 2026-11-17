import type worker from '../../schema/worker'
import { layout } from '@workbasehq/plugins/console/ui'
export default layout<typeof worker>(['name', { kind: 'slot', id: 'accessCard', props: { account: 'user' } }])
