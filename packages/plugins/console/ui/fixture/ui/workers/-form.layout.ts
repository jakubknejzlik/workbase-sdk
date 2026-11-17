import { col, type Node } from '@workbasehq/plugins/console/ui'
export default [{ kind: 'row', children: [col('name', { md: 8 }), col('status', { md: 4 })] }] satisfies Node[]
