import { customPage } from '@workbasehq/ui-v3'
import { TrasaView } from '../-components/TrasaView'
export default customPage({ title: 'workers.trasa.title', nav: { icon: 'map' }, uses: ['worker.name', 'slot.starts_at'], component: TrasaView })
