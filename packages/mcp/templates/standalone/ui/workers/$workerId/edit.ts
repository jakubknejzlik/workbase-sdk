import type worker from '../../../schema/worker'
import { entityEditPage } from '@workbasehq/plugins/console/ui'
import form from '../-form.layout.ts'
export default entityEditPage<typeof worker>('worker', { title: 'workers.edit.title', layout: form, recordParam: 'workerId', omit: ['user'] })
