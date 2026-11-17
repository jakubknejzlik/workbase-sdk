import { entityDetailPage } from '@workbasehq/plugins/console/ui'
import detail from '../-detail.layout.ts'
export default entityDetailPage('worker', { title: 'workers.detail.title', recordParam: 'workerId', layout: detail })
