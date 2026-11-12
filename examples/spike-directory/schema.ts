// Minimal schema projection: original field types, display fields and relations.
export default {
  workers: {
    singular: 'worker', displayField: 'name',
    fields: { name: { type: 'string', required: true }, user: { type: 'ref', userLink: true } },
    relations: { slots: { entity: 'slots', field: 'worker_id', many: true } },
  },
  jobs: {
    singular: 'job', displayField: 'title',
    fields: {
      title: { type: 'string', required: true },
      client_id: { type: 'ref', entity: 'clients', required: true },
      priority: { type: 'enum', values: ['low', 'normal', 'high'], default: 'normal', required: true },
      status: { type: 'enum', values: ['draft', 'scheduled', 'done'], default: 'draft', required: true, readOnly: true },
    },
    relations: { slots: { entity: 'slots', field: 'job_id', many: true } },
  },
  clients: {
    singular: 'client', displayField: 'name',
    fields: { name: { type: 'string' }, email: { type: 'string' } }, relations: {},
  },
  slots: {
    singular: 'slot', displayField: 'starts_at',
    fields: { starts_at: { type: 'datetime' }, job_id: { type: 'ref', entity: 'jobs' }, worker_id: { type: 'ref', entity: 'workers' }, booked: { type: 'int' } },
    relations: {},
  },
} as const

// Fixture records are data only. The SDK owns storage, relation filtering and save.
export const seed = {
  workers: [
    { id: 'w1', name: 'Alex Morgan', user: 'alex@example.test' },
    { id: 'w2', name: 'Sam Taylor' },
  ],
  clients: [
    { id: 'c1', name: 'Example Office', email: 'office@example.test' },
    { id: 'c2', name: 'Example Studio', email: 'studio@example.test' },
  ],
  jobs: [
    { id: 'j1', title: 'Office visit', client_id: 'c1', priority: 'normal', status: 'scheduled' },
    { id: 'j2', title: 'Studio visit', client_id: 'c2', priority: 'high', status: 'draft' },
  ],
  slots: [
    { id: 's1', worker_id: 'w1', job_id: 'j1', starts_at: '2026-11-13T08:00:00Z', booked: 2 },
    { id: 's2', worker_id: 'w1', job_id: 'j2', starts_at: '2026-11-13T12:30:00Z', booked: 1 },
    { id: 's3', worker_id: 'w2', job_id: 'j2', starts_at: '2026-11-14T09:00:00Z', booked: 3 },
  ],
}
