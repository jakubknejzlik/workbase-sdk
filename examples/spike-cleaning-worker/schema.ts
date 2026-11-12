// Minimal projection of Cleaning schema.v1 + v3 relations + v4 userLink.
// No invented worker fields: name, user; only slots relation.
export default {
  workers: {
    singular: 'worker',
    fields: { name: { type: 'string' }, user: { type: 'ref', userLink: true } },
    relations: { slots: { entity: 'slots' } },
  },
  slots: {
    singular: 'slot',
    fields: { starts_at: { type: 'datetime' }, job_id: { type: 'ref' }, booked: { type: 'int' } },
    relations: {},
  },
} as const
