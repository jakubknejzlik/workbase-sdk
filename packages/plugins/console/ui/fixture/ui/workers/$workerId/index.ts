import { entityDetailPage } from '@workbasehq/plugins/console/ui'
import detail from '../-detail.layout.ts'
export default entityDetailPage('worker', { grant: { entity: 'worker', operation: 'read' }, title: 'workers.detail.title', recordParam: 'workerId', layout: detail })
