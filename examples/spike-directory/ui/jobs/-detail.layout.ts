import { layout, columns, section, related } from './-model'
export default layout([
  columns([
    [[section('basic', ['title', 'client_id'], 'jobs.detail.basic'), related('slots', { columns: ['starts_at', 'worker_id', 'booked'] })], { xs: 12, sm: 12, md: 8, lg: 8, xl: 8 }],
    [[section('state', ['priority', 'status'], 'jobs.detail.state')], { xs: 12, sm: 12, md: 4, lg: 4, xl: 4 }],
  ]),
], { source: 'ui/jobs/-detail.layout.ts' })
