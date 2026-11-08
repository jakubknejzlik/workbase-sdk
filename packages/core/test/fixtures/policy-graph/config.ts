import { mailOutbox } from '@workbasehq/plugins/mail-outbox'
import { consoleUI } from '@workbasehq/plugins/console'
import { audit } from '@workbasehq/plugins/audit'
import { identity } from '@workbasehq/plugins/identity'
import { localAuth } from '@workbasehq/plugins/local-auth'
import { legacyPermissions as rbac } from '@workbasehq/plugins/permissions'
import { members } from '@workbasehq/plugins/members'
import { organizations } from '@workbasehq/plugins/organizations'
import { machineCredentials } from '@workbasehq/plugins/machine-credentials'
import { defineInstance, baseFields, type InstanceInput } from '../../../src/config'

export const roles = ['administrator', 'coordinator', 'operator', 'reviewer', 'team_user'] as const
const team = { team_id: { eq: '$actor.team_id' } }
const own = { id: { eq: '$actor.id' } }
const userUnion = { or: [own, team, { role: { in: ['coordinator', 'operator'] } }, { assignable_to_job: { eq: true } }] }
const jobUnion = { or: [{ reviewer_user_id: { eq: '$actor.id' } }, { reviewer_user: team }] }
const entities: InstanceInput['entities'] = {
  users: { displayField: 'name', fields: { name: { type: 'string', required: true }, role: { type: 'enum', values: [...roles, 'unknown'], required: true }, team_id: { type: 'ref', entity: 'teams' }, assignable_to_job: { type: 'bool', default: false } }, relations: { team: { entity: 'teams', field: 'team_id' } } },
  teams: { displayField: 'name', fields: { name: { type: 'string', required: true } }, relations: { team_users: { entity: 'users', field: 'team_id', many: true } } },
  records: { displayField: 'name', fields: { name: { type: 'string', required: true }, team_id: { type: 'ref', entity: 'teams', required: true } }, relations: { team: { entity: 'teams', field: 'team_id' }, jobs: { entity: 'jobs', field: 'record_id', many: true } } },
  jobs: { fields: { title: { type: 'string', required: true }, reviewer_user_id: { type: 'ref', entity: 'users' }, operator_user_id: { type: 'ref', entity: 'users' }, record_id: { type: 'ref', entity: 'records' }, report_id: { type: 'ref', entity: 'reports' }, internal_files_ids: { type: 'text', sensitive: true } }, relations: { reviewer_user: { entity: 'users', field: 'reviewer_user_id' }, record: { entity: 'records', field: 'record_id' } } },
  reports: { fields: { name: { type: 'string', required: true } }, relations: { jobs: { entity: 'jobs', field: 'report_id', many: true } } },
  work_logs: { displayField: 'minutes', fields: { operator_user_id: { type: 'ref', entity: 'users', required: true }, minutes: { type: 'int', required: true } } },
}
const ordinary = { administrator: 'all', coordinator: 'all', operator: 'all' } as const
const jobFields = [...baseFields, ...Object.keys(entities.jobs.fields).filter(field => field !== 'internal_files_ids')]
export const policyGraph = defineInstance({
  locale: 'en', timeZone: 'UTC',
  plugins: [identity, localAuth, rbac, members, organizations, machineCredentials(), mailOutbox(), consoleUI(), audit()], interactive: true,
  id: 'policy_graph', revision: 1, roles: [...roles, 'unknown'], account: { entity: 'users', assignments: ['role'] }, entities,
  permissions: Object.fromEntries([...roles, 'unknown'].map(role => [role, Object.fromEntries(Object.keys(entities).map(entity => [entity, ['read', 'create', 'update', 'delete']]))])),
  commands: ['records/move', 'users/change', 'records/bulk', 'records/create', 'records/delete', 'reports/rename'],
  policies: {
    records: { ...ordinary, reviewer: { where: team }, team_user: { where: team } },
    jobs: { administrator: 'all', coordinator: { where: {}, fields: [...jobFields, 'internal_files_ids'] }, operator: { where: {}, fields: [...jobFields, 'internal_files_ids'] }, reviewer: { where: jobUnion, fields: jobFields }, team_user: { where: jobUnion, fields: jobFields } },
    reports: { administrator: 'all', coordinator: 'none', operator: 'none', reviewer: { where: { jobs: { some: { reviewer_user_id: { eq: '$actor.id' } } } } },
      team_user: { where: { jobs: { some: { reviewer_user: { team: { team_users: { some: own } } } } } } } },
    users: { ...ordinary, reviewer: { where: userUnion }, team_user: { where: userUnion } },
    teams: { ...ordinary, reviewer: { where: { id: { eq: '$actor.team_id' } } }, team_user: { where: { id: { eq: '$actor.team_id' } } } },
    work_logs: { administrator: 'all', operator: { where: { operator_user_id: { eq: '$actor.id' } }, deny: 'forbidden' },
      coordinator: { where: { id: { in: [] } }, deny: 'forbidden' }, reviewer: { where: { id: { in: [] } }, deny: 'forbidden' }, team_user: { where: { id: { in: [] } }, deny: 'forbidden' } },
  },
})
export default policyGraph
