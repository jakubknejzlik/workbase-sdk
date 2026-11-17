import { entityCreatePage } from '@workbasehq/plugins/console/ui'
import form from './-form.layout.ts'
export default entityCreatePage('worker', { title: 'workers.create.title', layout: form, omit: ['user'] })
