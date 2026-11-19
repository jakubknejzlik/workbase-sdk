import type { ListInput } from '../../../src/list-contract'

/** Approved #222 reference, synthetic model only. Shared by parse/projection and MCP tests. */
export const workerList: ListInput = {
  columns: [
    { field: 'name', secondary: 'code' }, 'team_id', 'location_id', 'phone',
    { field: 'status', cell: { kind: 'badge', tones: { active: 'positive', inactive: 'neutral' } } },
    { field: 'created_at', cell: { kind: 'date' }, defaultVisible: false },
  ],
  filter: {
    team_id: { kind: 'relation', placement: 'toolbar' },
    location_id: { kind: 'relation', placement: 'panel' },
    status: { placement: 'panel' },
    created_at: { kind: 'date', placement: 'panel', operators: ['gte'], label: 'Vytvořeno od' },
  },
  rowAccess: { column: true, placement: 'panel' },
  views: [
    { id: 'all', label: 'Všichni', where: {}, default: true },
    { id: 'active', label: 'Aktivní', where: { status: { eq: 'active' } } },
    { id: 'inactive', label: 'Neaktivní', where: { status: { eq: 'inactive' } } },
    { id: 'invited', label: 'Čeká na přístup', where: {}, rowAccess: 'invited' },
  ],
  search: ['name', 'code'], defaultSort: { key: 'name', direction: 'asc' }, pageSize: 30,
}
export const workerEntities = {
  workers: { fields: {
    name: { type: 'string' as const }, code: { type: 'string' as const, ui: { format: 'identifier' as const } },
    team_id: { type: 'ref' as const, entity: 'teams' }, location_id: { type: 'ref' as const, entity: 'locations' },
    phone: { type: 'string' as const }, status: { type: 'enum' as const, values: ['active', 'inactive'] },
    user: { type: 'ref' as const, entity: 'users', userLink: true },
  }, relations: { account: { field: 'user', entity: 'users' }, team: { field: 'team_id', entity: 'teams' } } },
  teams: { fields: { name: { type: 'string' as const }, location_id: { type: 'ref' as const, entity: 'locations' } } },
  locations: { fields: { name: { type: 'string' as const } } },
  users: { fields: { name: { type: 'string' as const } } },
}
