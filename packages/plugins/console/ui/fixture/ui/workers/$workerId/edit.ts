import { entityEditPage } from '@workbasehq/plugins/console/ui'
import form from '../-form.layout.ts'
export default entityEditPage('worker', { title: 'workers.edit.title', recordParam: 'workerId', layout: form, omit: ['user'] })
