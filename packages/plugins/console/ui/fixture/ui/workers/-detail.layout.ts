import { slot, type Node } from '@workbasehq/plugins/console/ui'
export default ['name', 'status', 'locked', slot('fieldValue', { value: 'user' })] satisfies Node[]
