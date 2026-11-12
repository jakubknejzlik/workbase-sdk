import { layout, header, columns, section, row, tabs, tab, slot, related } from '../-model'
export default layout([
  header({ badges: [slot('accessBadge', { field: 'user' })] }),
  columns([
    [[
      section('basic', [row([['name', { xs: 12, md: 6 }]])], 'workers.detail.basic'),
      tabs([
        tab('slots', [related('slots', { columns: ['starts_at', 'job_id', 'booked'] })], 'workers.detail.slots'),
        tab('notes', [section('notes-empty', [], 'workers.detail.notesEmpty')], 'workers.detail.notes'),
      ]),
    ], { xs: 12, md: 8, lg: 8, xl: 8 }],
    [[slot('access', { field: 'user', allowInvite: true, allowRevoke: true })], { xs: 12, md: 4, lg: 4, xl: 4 }],
  ]),
], { omit: ['user'], source: 'ui/workers/-detail.layout.ts' })
