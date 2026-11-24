import { neutralConfig } from './config'

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
dashboard.contributes!.console!.pages = [{ id: 'neutral.summary', path: '/summary', label: 'Synthetic bookings',
  sections: [{ row: ['bookings', 'clients'] }], widgets: [
    { id: 'bookings', label: 'Bookings', kind: 'table', query: { entity: 'specimens', select: ['id', 'client', 'location', 'status', 'updated_at'], labels: ['client', 'location'], limit: 5 }, columns: ['client', 'location', 'status', 'updated_at'] },
    { id: 'clients', label: 'Clients', kind: 'list', query: { entity: 'specimens', select: ['id', 'client'], labels: ['client'], limit: 5 }, field: 'client' },
  ],
}]
