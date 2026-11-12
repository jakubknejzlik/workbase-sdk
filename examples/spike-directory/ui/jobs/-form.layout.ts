import { layout, section } from './-model'
export default layout([
  section('basic', ['title', 'client_id', 'priority', 'status'], 'jobs.detail.basic'),
], { source: 'ui/jobs/-form.layout.ts' })
