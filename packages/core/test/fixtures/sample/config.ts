import { versionData } from '../../../src/migrations/versions'
import { defineInstance, type InstanceInput } from '../../../src/config'
import { createIdentity } from '@workbasehq/plugins/identity'
import { createLocalAuth } from '@workbasehq/plugins/local-auth'
import { permissions } from '@workbasehq/plugins/permissions'
import { createMembers } from '@workbasehq/plugins/members'
import { createOrganizations } from '@workbasehq/plugins/organizations'
import { machineCredentials } from '@workbasehq/plugins/machine-credentials'
import { mailOutbox } from '@workbasehq/plugins/mail-outbox'
import { consoleUI } from '@workbasehq/plugins/console'
import { audit } from '@workbasehq/plugins/audit'

// A small relational graph for CRUD, query, authorization and plugin contracts.
// Commands are declarations for tests that supply their own implementations.
const entities: InstanceInput['entities'] = {
  clients: { displayField: 'name', fields: { name: { type: 'string', required: true }, email: { type: 'string', sensitive: true } }, relations: { jobs: { entity: 'jobs', field: 'client_id', many: true } } },
  workers: { displayField: 'name', fields: { name: { type: 'string', required: true } }, relations: { slots: { entity: 'slots', field: 'worker_id', many: true } } },
  jobs: { displayField: 'title', fields: { title: { type: 'string', required: true }, client_id: { type: 'ref', entity: 'clients', required: true }, priority: { type: 'enum', values: ['low', 'normal', 'high'], default: 'normal', required: true }, status: { type: 'enum', values: ['draft', 'scheduled', 'done'], default: 'draft', required: true, readOnly: true } }, relations: { client: { entity: 'clients', field: 'client_id' }, slots: { entity: 'slots', field: 'job_id', many: true } } },
  slots: { displayField: 'starts_at', fields: { job_id: { type: 'ref', entity: 'jobs', required: true }, worker_id: { type: 'ref', entity: 'workers' }, starts_at: { type: 'datetime', required: true }, capacity: { type: 'int', required: true, min: 1 }, booked: { type: 'int', required: true, default: 0, min: 0, readOnly: true } }, relations: { job: { entity: 'jobs', field: 'job_id' }, worker: { entity: 'workers', field: 'worker_id' }, bookings: { entity: 'bookings', field: 'slot_id', many: true } }, checks: [{ left: 'booked', op: '<=', right: 'capacity' }] },
  bookings: { displayField: 'client_snapshot_name', commandsOnly: true, fields: { slot_id: { type: 'ref', entity: 'slots', required: true }, client_id: { type: 'ref', entity: 'clients', required: true }, status: { type: 'enum', values: ['confirmed', 'cancelled'], required: true }, client_snapshot_name: { type: 'string', required: true, default: '', readOnly: true } }, relations: { slot: { entity: 'slots', field: 'slot_id' }, client: { entity: 'clients', field: 'client_id' } } },
  stock_items: { displayField: 'name', commandsOnly: true, fields: { name: { type: 'string', required: true }, quantity: { type: 'int', required: true, min: 0, readOnly: true } } },
}
const roles = ['owner', 'dispatcher', 'viewer']
const baseSample = defineInstance({
  id: 'sample', displayName: 'Sample', revision: 3, interactive: true, registration: 'open',
  plugins: [createIdentity(), permissions({ roles, ownerRole: 'owner' }), createMembers(), createOrganizations({ allowCreate: true }), createLocalAuth({ methods: ['magic-link'] }), machineCredentials(), mailOutbox(), consoleUI(), audit()],
  entities, roles,
  permissions: Object.fromEntries(roles.map(role => [role, Object.fromEntries(Object.keys(entities).map(entity => [entity, role === 'viewer' ? ['read'] : ['read', 'create', 'update', 'delete']]))])),
  policies: Object.fromEntries(Object.keys(entities).map(entity => [entity, Object.fromEntries(roles.map(role => [role, 'all' as const]))])),
  commands: ['bookings/create', 'bookings/cancel', 'bookings/move', 'reservations/pair', 'stock/consume', 'reservations/equipped', 'jobs/transition'],
})
const first = versionData(baseSample)
const second = versionData(baseSample)
// Two synthetic historical revisions exercise safe rollback and added-field diffs.
for (const version of [first, second]) {
  const entities = version.entities as InstanceInput['entities']
  delete entities.stock_items
  for (const grants of Object.values(version.permissions as Record<string, Record<string, unknown>>)) delete grants.stock_items
  delete (version.policies as Record<string, unknown>).stock_items
}
delete (first.entities as InstanceInput['entities']).jobs.fields.priority
export const sample = defineInstance({ ...baseSample, plugins: baseSample.plugins!.map(plugin => plugin.name === 'console' ? consoleUI({ history: [{ revision: 1, config: first }, { revision: 2, config: second }] }) : plugin) })
export default sample
