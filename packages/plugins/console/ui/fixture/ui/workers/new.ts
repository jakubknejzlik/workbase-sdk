import { entityCreatePage } from '@workbasehq/plugins/console/ui'
import form from './-form.layout.ts'
export default entityCreatePage('worker', { grant: { entity: 'worker', operation: 'create' }, title: 'workers.create.title', layout: form, omit: ['user'] })
