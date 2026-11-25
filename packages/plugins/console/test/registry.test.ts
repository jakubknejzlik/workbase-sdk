import { assert, beforeEach, expect, it } from 'vitest'
import sample from '../../../core/test/fixtures/sample/config'
import { createApp } from '@workbasehq/core/app'
import { KernelRegistry } from '@workbasehq/core/kernel/registry'
import { requireScope } from '../../../core/src/authorization'
import type { InstanceConfig } from '@workbasehq/core/config'
import type { ConsoleModelContract } from '@workbasehq/core/console-contract'
import { request, runtime, setup } from '@workbasehq/test-support/helpers'
import { consoleUI, consoleRegistry } from '../src/index'

beforeEach(async () => { await setup() })
async function providerRegistry(config: InstanceConfig, user = 'owner-a') {
  const kernel = new KernelRegistry(config)
  const actor = await kernel.requireActor(new Request('http://localhost', { headers: { Authorization: `Bearer synthetic-${user}` } }), runtime())
  return consoleRegistry(kernel.config, await requireScope(actor, 'org-a', kernel.config))
}
it.each([false, true])('SR-72 audit installation=%s controls API and registry placement', async installed => {
  const config = { ...sample, plugins: sample.plugins!.filter(plugin => installed || plugin.name !== 'audit') }
  const app = createApp(config, runtime())
  expect((await request(app, '/audit/events')).status).toBe(installed ? 200 : 404)
  const response = await request(app, '/o/org-a/console-model')
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  const { console: registry } = await response.json() as ConsoleModelContract
  assert(registry)
  expect(registry.pages.some(page => page.id === 'audit.activity')).toBe(installed)
  expect(registry.navigation.some(item => item.page === 'audit.activity')).toBe(installed)
  expect(registry.pages.some(page => page.id === 'core.workflows')).toBe(true)
})
it('fails startup clearly when audit requires console but it is absent', () => {
  expect(() => createApp({ ...sample, plugins: sample.plugins!.filter(plugin => plugin.name !== 'console') }, runtime()))
    .toThrow('Plugin audit: missing required contract console@^1')
})
it('a headless instance has no console provider or audit endpoint', async () => {
  const config = { ...sample, plugins: sample.plugins!.filter(plugin => !['audit', 'console'].includes(plugin.name)) }
  const app = createApp(config, runtime())
  expect((await request(app, '/audit/events')).status).toBe(404)
  expect(new KernelRegistry(config).plugins.some(plugin => plugin.consoleRegistry)).toBe(false)
})
it('rejects UI contributions without an explicit console dependency', () => {
  expect(() => new KernelRegistry({ ...sample, plugins: [...sample.plugins!, { name: 'bad-ui', version: '1', contributes: { console: { pages: [] } } }] }))
    .toThrow('Plugin bad-ui: console contributions require console@^1')
})
it('rejects duplicate page IDs at startup', () => {
  expect(() => new KernelRegistry({ ...sample, plugins: [...sample.plugins!, { name: 'duplicate-ui', version: '1', requires: { console: '^1' }, contributes: { console: { pages: [{ id: 'audit.activity', label: 'duplicate', path: '/duplicate', renderer: 'duplicate' }] } } }] }))
    .toThrow('Duplicate console page: audit.activity')
})
it('console is an explicit versioned contract', () => expect(consoleUI().provides).toEqual({ console: '1.x' }))

it('filters pages, entity placements and role-specific navigation on the server', async () => {
  const app = createApp(sample, runtime())
  const response = await request(app, '/o/org-a/console-model', 'GET', undefined, 'viewer-a')
  const { console: registry } = await response.json() as ConsoleModelContract
  assert(registry)
  expect(registry.pages.some(page => page.id === 'audit.activity')).toBe(false)
  expect(registry.navigation.some(item => item.page === 'audit.activity')).toBe(false)
  expect(registry.navigation.filter(item => item.entity).every(item => item.placement === 'sidebar')).toBe(true)
  expect((await request(app, '/o/org-b/console-model', 'GET', undefined, 'owner-a')).status).toBe(403)
  expect((await app.request('/o/org-a/console-model')).status).toBe(401)
})
it('carries existing model and field UI hints unchanged and merges display contributions', async () => {
  const fieldUi = { hidden: false, section: 'private' }
  const ui = { ...sample.ui, entities: { ...sample.ui?.entities, clients: { list: { columns: [{ field: 'name' }], search: ['name'] }, detail: { fields: ['name'] } } } }
  const config = { ...sample, ui, entities: { ...sample.entities, clients: { ...sample.entities.clients, fields: { ...sample.entities.clients.fields, name: { ...sample.entities.clients.fields.name, ui: fieldUi } } } }, plugins: [...sample.plugins!, {
    name: 'display-demo', version: '1', requires: { console: '^1' as const }, contributes: { console: {
      entities: { clients: { form: { create: { fields: ['name'] }, edit: { fields: ['name'] } }, sections: [{ id: 'main', label: 'Main', fields: ['name'] }] } },
      pages: [{ id: 'demo.custom', path: '/p/demo', label: 'Demo', renderer: 'members.list', grant: 'members.read' }],
      navigation: [{ id: 'demo.custom', placement: 'sidebar' as const, label: 'Demo', page: 'demo.custom', order: -1 }],
    } },
  }] }
  const registry = await providerRegistry(config)
  expect(registry.modelUi).toEqual(ui)
  expect(registry.entities.clients).toMatchObject({ ...ui.entities.clients, fields: { name: fieldUi }, form: { create: { fields: ['name'] }, edit: { fields: ['name'] } } })
  expect(registry.pages.find(page => page.id === 'demo.custom')).toMatchObject({ path: '/p/demo', renderer: 'members.list' })
  expect(registry.navigation[0].id).toBe('demo.custom')
})
it('an uninstalled Audit API returns 404 even to an anonymous request', async () => {
  const app = createApp({ ...sample, plugins: sample.plugins!.filter(plugin => plugin.name !== 'audit') }, runtime())
  expect((await app.request('/audit/events')).status).toBe(404)
})
it('filters contributed role/grant placements and unreadable entity views before serialization', async () => {
  const config = { ...sample,
    ui: { ...sample.ui, entities: { ...sample.ui?.entities, clients: { list: { views: [{ id: 'named', label: 'Named', where: { name: { eq: 'Private' } } }] } } }, navigation: { groups: [{ id: 'customers', label: 'Customers' }], items: [{ id: 'named_clients', entity: 'clients', group: 'customers', view: 'named' }] } },
    plugins: [...sample.plugins!, {
      name: 'scoped-ui', version: '1', requires: { console: '^1' as const },
      fieldMask: (_entity: string, scope: import('../../../core/src/types').Scope) => scope.role === 'owner' ? ['id', 'name'] : ['id'],
      contributes: { console: { navigation: [
        { id: 'owners', placement: 'sidebar' as const, label: 'Owners', page: 'core.overview', roles: ['owner'] },
        { id: 'authorized-tokens', placement: 'settings' as const, label: 'Tokens shortcut', page: 'core.overview', grant: 'tokens.read' },
      ] } },
    }],
  }
  const owner = await providerRegistry(config)
  for (const id of ['owners', 'authorized-tokens', 'entity.named_clients']) expect(owner.navigation.some(item => item.id === id)).toBe(true)
  const viewer = await providerRegistry(config, 'viewer-a')
  for (const id of ['owners', 'authorized-tokens', 'entity.named_clients']) expect(viewer.navigation.some(item => item.id === id)).toBe(false)
  expect(viewer.navigation.some(item => item.group?.id === 'customers')).toBe(false)
})

// E2 configuration is deliberately data-only; casts also exercise untyped config loads.
function actionConfig(actions: unknown) {
  return { ...sample, plugins: [...sample.plugins!, { name: 'quick-actions', version: '1', requires: { console: '^1' as const }, contributes: { console: {
    pages: [{ id: 'quick', path: '/quick', label: 'Quick', renderer: 'custom', actions }],
  } } }] } as InstanceConfig
}
const primaryNavigation = { id: 'open', label: 'openKey', description: 'openDescription', icon: 'Folder', primary: true, target: { navigation: 'entity.clients' } }
it.each([
  null, {}, Array(13).fill(primaryNavigation), [primaryNavigation, primaryNavigation],
  [{ ...primaryNavigation, id: '../escape' }], [{ ...primaryNavigation, id: '' }],
  [{ ...primaryNavigation, primary: false }], [primaryNavigation, { ...primaryNavigation, id: 'other' }],
  [{ ...primaryNavigation, target: { navigation: 'missing' } }],
  [{ ...primaryNavigation, target: { create: 'missing' } }],
  [{ ...primaryNavigation, target: { command: 'missing/action' } }],
  [{ ...primaryNavigation, target: { url: 'https://example.test' } }],
  [{ ...primaryNavigation, target: { navigation: 'entity.clients', create: 'clients' } }],
  [{ ...primaryNavigation, icon: 'UnknownIcon' }], [{ ...primaryNavigation, callback: 'run' }], [{ ...primaryNavigation, label: '<b>Run</b>' }],
])('E2 rejects malformed or unsupported actions at config load: %j', actions => {
  expect(() => new KernelRegistry(actionConfig(actions))).toThrow(/console action/i)
})
it('E2 projects navigation against live roles, views and grants without promoting a denied primary', async () => {
  const config = actionConfig([primaryNavigation, { id: 'audit', label: 'auditKey', target: { navigation: 'audit.activity' } }])
  const owner = await providerRegistry(config)
  expect(owner.pages.find(page => page.id === 'quick')?.actions).toHaveLength(2)
  const viewer = await providerRegistry(config, 'viewer-a')
  expect(viewer.pages.find(page => page.id === 'quick')?.actions).toEqual([primaryNavigation])
  const restricted = { ...actionConfig([{ ...primaryNavigation, target: { navigation: 'audit.activity' } }, { id: 'secondary', label: 'secondaryKey', target: { navigation: 'core.overview' } }]), ui: { ...config.ui, entities: config.ui?.entities ?? {}, navigation: { groups: [], items: [{ id: 'clients', entity: 'clients', roles: ['owner'] }] } } }
  expect((await providerRegistry(restricted, 'viewer-a')).pages.find(page => page.id === 'quick')?.actions).toEqual([{ id: 'secondary', label: 'secondaryKey', target: { navigation: 'core.overview' } }])
})
it('E2 preserves descriptor-free pages and the configured overview fallback', async () => {
  expect((await providerRegistry(sample)).pages.every(page => !Object.hasOwn(page, 'actions'))).toBe(true)
  const config = actionConfig([])
  const contribution = config.plugins!.at(-1)!.contributes!.console!
  contribution.pages = contribution.pages!.map(page => ({ ...page, path: '/' }))
  const registry = await providerRegistry(config)
  expect(registry.navigation.find(item => item.id === 'core.overview')?.page).toBe('quick')
})

it('E2 resolves create precedence and collection forms from runtime definitions, with live input and additional grants', async () => {
  const { z } = await import('zod')
  const { defineCommand } = await import('../../../core/src/commands')
  const { scopeOperations } = await import('../../../core/src/scope-operations')
  const make = (name: string, input = z.object({ note: z.string() })) => defineCommand({ name, input,
    permission: { entity: 'clients', operation: 'update' }, plan: () => ({ rules: [], result: { status: 200, body: {} }, event: { operation: 'test', entity: 'clients', entityId: 'synthetic' } }) })
  const create = { ...make('clients/new'), ui: { placement: { entity: 'clients', action: 'create' as const } } }
  const secondCreate = { ...make('clients/other'), ui: create.ui }
  const collect = make('clients/batch/collect')
  const reference = make('clients/reference', z.object({ worker: z.string().meta({ referenceEntity: 'workers' }) }) as any)
  const extra = { ...make('clients/extra'), additionalPermissions: [{ entity: 'workers', operation: 'delete' as const }] }
  const definitions = [create, secondCreate, collect, reference, extra]
  const actions = [
    { id: 'new', label: 'newKey', primary: true, target: { create: 'clients' } },
    ...definitions.map((command, index) => ({ id: `command${index}`, label: `command${index}Key`, target: { command: command.name } })),
  ]
  const project = (config: InstanceConfig, fields = ['id', 'name', 'version']) => {
    const kernel = new KernelRegistry({ ...config, commands: definitions.map(command => command.name), plugins: [...config.plugins!, {
      name: 'input-masks', version: '1', fieldMask: (entity: string) => entity === 'workers' ? fields : ['id', 'name', 'version'],
      commandGuard: (_command: import('../../../core/src/kernel/plugin').KernelCommand, scope: import('../../../core/src/types').Scope) => scope.role === 'blocked' ? { allow: false as const, code: 'permission_denied' } : { allow: true as const },
    }] }, { commands: new Map(definitions.map(command => [command.name, command])) })
    const scope = { organizationId: 'org-a', actor: { type: 'user' as const, id: 'owner-a' }, role: 'owner', correlationId: 'actions' }
    scopeOperations.set(scope, { operations: null })
    return { kernel, scope, actions: consoleRegistry(kernel.config, scope).pages.find(page => page.id === 'quick')!.actions }
  }
  const config = actionConfig(actions)
  expect(project(config).actions?.map(action => action.target)).toEqual([
    { create: 'clients' }, { command: collect.name }, { command: reference.name }, { command: extra.name },
  ])
  const commandsOnly = { ...config, entities: { ...config.entities, clients: { ...config.entities.clients, commandsOnly: true } } }
  expect(project(commandsOnly).actions?.map(action => action.target)).toEqual([
    { command: create.name }, { command: create.name }, { command: collect.name }, { command: reference.name }, { command: extra.name },
  ])
  expect(project(config, []).actions?.map(action => action.target)).toEqual([{ create: 'clients' }, { command: collect.name }, { command: extra.name }])
  const grants = { ...config, permissions: { ...config.permissions, owner: { ...config.permissions.owner, workers: ['read' as const] } } }
  expect(project(grants).actions?.some(action => 'command' in action.target && action.target.command === extra.name)).toBe(false)
  const { kernel, scope } = project(config)
  const viewer = { ...scope, role: 'viewer' }; scopeOperations.set(viewer, { operations: null })
  const blocked = { ...scope, role: 'blocked' }; scopeOperations.set(blocked, { operations: null })
  expect(consoleRegistry(kernel.config, viewer).pages.find(page => page.id === 'quick')!.actions).toEqual([])
  expect(consoleRegistry(kernel.config, blocked).pages.find(page => page.id === 'quick')!.actions).toEqual([])
})
it.each(['row', 'unsupported', 'undeclared'])('E2 rejects %s runtime command targets during construction', async kind => {
  const { z } = await import('zod')
  const { defineCommand } = await import('../../../core/src/commands')
  const command = defineCommand({ name: 'clients/collect', input: kind === 'row' ? z.object({ id: z.string().meta({ referenceEntity: 'clients' }) }) : kind === 'unsupported' ? z.string() : z.object({}),
    permission: { entity: 'clients', operation: 'update' }, plan: () => ({ rules: [], result: { status: 200, body: {} }, event: { operation: 'test', entity: 'clients', entityId: 'synthetic' } }) })
  expect(() => new KernelRegistry({ ...actionConfig([{ id: 'collect', label: 'collectKey', primary: true, target: { command: command.name } }]), commands: kind === 'undeclared' ? [] : [command.name] }, { commands: new Map([[command.name, command]]) })).toThrow(/console action/i)
})
