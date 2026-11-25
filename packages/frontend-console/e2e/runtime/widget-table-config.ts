import { neutralConfig } from './config'
import type { ConsolePage } from '../../../core/src/console-contract'

// Synthetic four-column booking case from #304; ordinary SDK schema and widgets only.
export const widgetTableConfig = neutralConfig()
Object.assign(widgetTableConfig.entities.specimens.fields, {
  client: { type: 'ref', entity: 'clients' }, location: { type: 'ref', entity: 'locations' },
  status: { type: 'string' },
})
for (const entity of ['clients', 'locations']) {
  widgetTableConfig.entities[entity] = { displayField: 'name', fields: { name: { type: 'string', required: true } }, relations: {}, checks: [] }
  widgetTableConfig.permissions!.owner[entity] = ['read']
  widgetTableConfig.policies![entity] = { owner: 'all' }
}
widgetTableConfig.policies!.specimens.owner = 'all'
widgetTableConfig.ui!.entities!.specimens.list = { columns: ['client', 'location', 'status', 'updated_at'].map(field => ({ field })) }
const dashboard = widgetTableConfig.plugins!.find(plugin => plugin.name === 'neutral-dashboard')!
const pages: ConsolePage[] = dashboard.contributes!.console!.pages = [{ id: 'neutral.summary', path: '/summary', label: 'Synthetic bookings',
  sections: [{ row: ['bookings', 'clients'] }, { row: ['count'] }], widgets: [
    { id: 'count', label: 'dashboard_specimen_count', kind: 'stat', query: { entity: 'specimens' }, aggregate: { fn: 'count' } },
    { id: 'bookings', label: 'dashboard_attention', kind: 'table', query: { entity: 'specimens', select: ['id', 'client', 'location', 'status', 'updated_at'], labels: ['client', 'location'], limit: 5 }, columns: ['client', 'location', 'status', 'updated_at'] },
    { id: 'clients', label: 'dashboard_clients', kind: 'list', query: { entity: 'specimens', select: ['id', 'client'], labels: ['client'], limit: 5 }, field: 'client' },
  ],
}]

// Existing sections alone prioritize attention; array order remains the legacy fallback.
pages.push({ ...pages[0], id: 'neutral.default', path: '/default', sections: undefined })
pages.push({ ...pages[0], id: 'neutral.isolated', path: '/isolated', sections: [{ row: ['bookings', 'clients'] }, { row: ['count', 'unavailable'] }], widgets: [
  ...pages[0].widgets!,
  { id: 'unavailable', label: 'Unavailable records', kind: 'table', columns: ['id'], query: { entity: 'specimens', select: ['id'], limit: 5, contextList: { entity: 'specimens', list: 'missing', id: 'booking-0' } } },
] })
Object.assign(widgetTableConfig.enumLabels!.en, {
  dashboard_attention: 'Bookings that need attention and confirmation from the team',
  dashboard_clients: 'Clients associated with the current bookings',
})
Object.assign(widgetTableConfig.enumLabels!.cs, {
  dashboard_attention: 'Rezervace vyžadující pozornost a potvrzení odpovědným pracovníkem',
  dashboard_clients: 'Klienti přiřazení k aktuálně zobrazeným rezervacím',
})
