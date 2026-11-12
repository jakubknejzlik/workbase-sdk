import { layout, section, row, slot } from '../-model'
export default layout([
  section('basic', [row([['name', { xs: 12, md: 6 }]])], 'workers.detail.basic'),
  slot('invite', { field: 'user', when: 'create' }),
], { omit: ['user'], source: 'ui/workers/-form.layout.ts' })
