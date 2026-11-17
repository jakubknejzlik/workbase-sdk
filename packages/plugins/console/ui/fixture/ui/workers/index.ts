import { entityListPage } from '@workbasehq/plugins/console/ui'
export default entityListPage('worker', { grant: { entity: 'worker', operation: 'read' }, title: 'workers.list.title', layout: ['name', 'status'] })
