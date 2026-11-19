import { expect, it } from 'vitest'
import { defineInstance } from '../src/config'
import { KernelRegistry } from '../src/kernel/registry'
import { consoleModel } from '../src/console-model'
import { loadActorProjection } from '../src/policies'
import { scopeOperations } from '../src/scope-operations'
import { identity } from '@workbasehq/plugins/identity'
import { localAuth } from '@workbasehq/plugins/local-auth'
import { legacyPermissions } from '@workbasehq/plugins/permissions'
import { members } from '@workbasehq/plugins/members'
import { consoleUI } from '@workbasehq/plugins/console'
import type { Scope } from '../src/types'
import type { KernelCommand } from '../src/kernel/plugin'
import { workerList, workerEntities } from './fixtures/list-v2/workers'

const scope: Scope = { role: 'owner', organizationId: 'org', correlationId: 'synthetic', actor: { type: 'user', id: 'owner' } }
scopeOperations.set(scope, { operations: null })
const roles = ['owner']
function config(options: { create: boolean; invitationsRead: boolean; mask?: string[]; sensitive?: boolean; override?: boolean }) {
  const list = { ...workerList, relatedColumns: { team_location: { via: 'team_id', field: 'location_id' } }, filter: { ...workerList.filter, team_location: 'text' as const } }
  return defineInstance({ id: 'approved_workers', revision: 1, roles, account: { entity: 'users' }, interactive: true,
    plugins: [identity, localAuth, legacyPermissions, members, consoleUI(),
      ...(!options.invitationsRead ? [{ name: 'deny-invitations-read', version: '1', commandGuard: (command: KernelCommand) => 'system' in command.permission && command.permission.system === 'invitations.read' ? { allow: false as const, code: 'permission_denied' } : { allow: true as const } }] : []),
      ...(options.mask ? [{ name: 'mask', version: '1', fieldMask: (entity: string) => entity === 'workers' ? options.mask! : ['id', 'name', 'location_id'] }] : []),
      ...(options.override ? [{ name: 'list-override', version: '1', requires: { console: '^1' as const }, contributes: { console: {
        entities: { workers: { list } }, navigation: [{ id: 'override.invited', entity: 'workers', view: 'invited', placement: 'sidebar' as const, label: 'Invited' }],
      } } }] : []),
    ],
    entities: { ...workerEntities, workers: { ...workerEntities.workers, fields: { ...workerEntities.workers.fields, status: { ...workerEntities.workers.fields.status, sensitive: options.sensitive } } } },
    permissions: { owner: Object.fromEntries(Object.keys(workerEntities).map(entity => [entity, options.create ? ['read', 'create'] : ['read']])) },
    policies: Object.fromEntries(Object.keys(workerEntities).map(entity => [entity, { owner: 'all' as const }])),
    organizationPermissions: { owner: ['invitations.create', ...(options.invitationsRead ? ['invitations.read' as const] : [])] },
    ui: { entities: { workers: { list } }, navigation: { groups: [], items: [
      { id: 'all', entity: 'workers', view: 'all' }, { id: 'active', entity: 'workers', view: 'active' }, { id: 'invited', entity: 'workers', view: 'invited' },
    ] } },
  })
}
for (const override of [false, true]) for (const create of [false, true]) for (const invitationsRead of [false, true]) {
  it(`projects approved Workers across all copies: override=${override}, create=${create}, invitations.read=${invitationsRead}`, async () => {
    const source = config({ override, create, invitationsRead })
    const before = JSON.stringify(source.ui)
    await loadActorProjection(source, scope, async <T>() => ({ id: 'owner', name: 'Owner', user_id: 'owner', organization_id: 'org', role: 'owner' }) as T)
    const body = consoleModel(new KernelRegistry(source), scope)
    expect(body.contractVersion).toBe(2)
    expect(body.model.entities.workers.rowInvitations === true).toBe(create)
    // Query eligibility is independent of the stricter list presentation gate.
    expect(body.model.entities.workers.rowAccess).toBe(invitationsRead)
    const displays = [body.model.entities.workers, body.model.ui!.entities!.workers, body.console!.entities.workers, body.console!.modelUi!.entities!.workers]
    for (const hints of displays) {
      expect(hints.list!.columns).toEqual(source.ui!.entities.workers.list!.columns)
      expect(hints.list!.filter!.team_id).toMatchObject({ kind: 'relation', placement: 'toolbar', operators: ['in'] })
      expect(hints.list!.filter!.team_location).toMatchObject({ kind: 'text', operators: ['contains'] })
      expect(hints.list!.rowAccess !== undefined).toBe(create && invitationsRead)
      expect(hints.list!.views!.some(view => view.id === 'invited')).toBe(create && invitationsRead)
    }
    expect(body.model.entities.workers.listColumns).toEqual(workerList.columns!.map(column => typeof column === 'string' ? column : column.field))
    for (const navigation of [body.model.ui!.navigation!.items, body.console!.modelUi!.navigation!.items, body.console!.navigation]) {
      expect(navigation.some(item => item.view === 'invited')).toBe(create && invitationsRead)
      expect(navigation.some(item => item.view === 'all')).toBe(true)
    }
    expect(JSON.stringify(source.ui)).toBe(before)
    expect(workerList.filter!.status).toEqual({ placement: 'panel' })
  })
}
it.each([false, true])('prunes primary/secondary and sensitive literals in every copy, override=%s', async override => {
  const source = config({ override, create: true, invitationsRead: true, mask: ['id', 'name', 'status', 'created_at', 'team_id'], sensitive: true })
  await loadActorProjection(source, scope, async <T>() => ({ id: 'owner', name: 'Owner', user_id: 'owner', organization_id: 'org', role: 'owner' }) as T)
  const body = consoleModel(new KernelRegistry(source), scope)
  for (const hints of [body.model.entities.workers, body.model.ui!.entities!.workers, body.console!.entities.workers, body.console!.modelUi!.entities!.workers]) {
    expect(hints.list!.columns!.map(column => column.field)).toEqual(['name', 'team_id', 'status', 'created_at'])
    expect(hints.list!.columns![0]).toEqual({ field: 'name' })
    expect(hints.list!.columns![2].cell).toEqual({ kind: 'badge' })
    expect(hints.list!.filter).not.toHaveProperty('status')
    expect(hints.list!.filter).not.toHaveProperty('location_id')
    expect(hints.list!.views!.map(view => view.id)).toEqual(['all', 'invited'])
    expect(hints.list!.search).toEqual(['name'])
  }
  for (const navigation of [body.model.ui!.navigation!.items, body.console!.modelUi!.navigation!.items, body.console!.navigation]) expect(navigation.some(item => item.view === 'active')).toBe(false)
})
it('normalizes plugin shorthand without mutating contributions and rejects invalid plugin list hints', () => {
  const source = config({ create: true, invitationsRead: true, override: true })
  const plugin = source.plugins!.find(plugin => plugin.name === 'list-override')!
  const before = JSON.stringify(plugin.contributes)
  new KernelRegistry(source)
  consoleModel(new KernelRegistry(source), scope)
  expect(JSON.stringify(plugin.contributes)).toBe(before)
  const badPlugin = { ...plugin, contributes: { console: { entities: { workers: { list: { columns: ['missing'] } } } } } }
  expect(() => new KernelRegistry(defineInstance({ ...source, plugins: [...source.plugins!.filter(p => p !== plugin), badPlugin] }))).toThrow(/column/)
})
