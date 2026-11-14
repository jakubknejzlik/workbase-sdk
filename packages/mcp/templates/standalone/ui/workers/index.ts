import type worker from '../../schema/worker'
import { entityListPage } from '@workbasehq/plugins/console/ui'
export default entityListPage<typeof worker>('worker', { title: 'workers.list.title', layout: ['name'] })
