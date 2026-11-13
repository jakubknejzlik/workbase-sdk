import { list, slot } from '../-model'
export default list([
  'name',
  slot('accessBadge', { field: 'user' }),
], { orderBy: 'name', search: ['name'], source: 'ui/workers/-list.ts' })
