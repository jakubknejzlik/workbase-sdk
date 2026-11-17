import type worker from '../../schema/worker'
import { entityCreatePage } from '@workbasehq/plugins/console/ui'
import form from './-form.layout.ts'
export default entityCreatePage<typeof worker>('worker', { title: 'workers.create.title', layout: form, omit: ['user'] })
