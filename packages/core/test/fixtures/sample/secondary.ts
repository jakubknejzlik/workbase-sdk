import { defineInstance, type InstanceInput } from '../../../src/config'
import sample from './config'

// A dependency chain exercises child-before-parent migration ordering.
const entities: InstanceInput['entities'] = {
  clients: { displayField: 'name', fields: { name: { type: 'string', required: true } } },
  tasks: { displayField: 'title', fields: { title: { type: 'string', required: true }, client_id: { type: 'ref', entity: 'clients', required: true } } },
  notes: { displayField: 'body', fields: { request_id: { type: 'ref', entity: 'tasks', required: true }, body: { type: 'string', required: true } } },
}
export default defineInstance({
  ...sample, id: 'secondary', revision: 1, entities, commands: [],
  permissions: Object.fromEntries(sample.roles.filter(role => role !== 'member').map(role => [role, Object.fromEntries(Object.keys(entities).map(entity => [entity, role === 'viewer' ? ['read'] : ['read', 'create', 'update', 'delete']]))])),
  policies: Object.fromEntries(Object.keys(entities).map(entity => [entity, Object.fromEntries(sample.roles.map(role => [role, 'all' as const]))])),
})
