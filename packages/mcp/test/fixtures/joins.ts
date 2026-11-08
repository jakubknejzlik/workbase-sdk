import { defineInstance } from '@workbasehq/core/config'
import { defineAtomicOperation } from '@workbasehq/core/execution/atomic'
import { z } from 'zod'
const through = (entity: string, field: string) => ({ entity, field, createCommand: 'enrollments/create', deleteCommand: 'enrollments/delete' })
export const joinConfig = defineInstance({
  id: 'joins', revision: 1, roles: ['owner'],
  entities: {
    people: { fields: { name: { type: 'string', required: true } }, relations: { teams: { entity: 'enrollments', field: 'person_id', many: true, through: through('teams', 'team_id') } } },
    teams: { fields: { name: { type: 'string', required: true } }, relations: { people: { entity: 'enrollments', field: 'team_id', many: true, through: through('people', 'person_id') } } },
    enrollments: { commandsOnly: true, displayField: 'id', fields: { person_id: { type: 'ref', entity: 'people', required: true }, team_id: { type: 'ref', entity: 'teams', required: true } } },
  }, permissions: { owner: { people: ['read'], teams: ['read'], enrollments: ['read', 'create', 'delete'] } },
  commands: ['enrollments/create', 'enrollments/delete'],
})
export const joinCommands = new Map(['create', 'delete'].map(operation => {
  const name = `enrollments/${operation}`
  return [name, defineAtomicOperation({ name, permission: { entity: 'enrollments', operation: operation as 'create' | 'delete' },
    input: operation === 'create' ? z.strictObject({ personId: z.string().meta({ referenceEntity: 'people' }), teamId: z.string().meta({ referenceEntity: 'teams' }) }) : z.strictObject({ id: z.string().meta({ referenceEntity: 'enrollments' }) }),
    plan: () => { throw new Error('Schema-only fixture') },
  })]
}))
