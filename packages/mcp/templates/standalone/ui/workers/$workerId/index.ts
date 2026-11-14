import type worker from '../../../schema/worker'
import { entityDetailPage } from '@workbasehq/plugins/console/ui'
import detail from '../-detail.layout.ts'
export default entityDetailPage<typeof worker>('worker', { title: 'workers.detail.title', layout: detail, recordParam: 'workerId' })
