import { beforeEach, expect, it } from 'vitest'
import sample from '../../../core/test/fixtures/sample/config'
import { createApp } from '@workbasehq/core/app'
import { KernelRegistry } from '@workbasehq/core/kernel/registry'
import { request, runtime, setup } from '@workbasehq/test-support/helpers'
import { consoleUI, consoleRegistry } from '../src/index'

beforeEach(async () => { await setup() })
it.each([false, true])('SR-72 audit installation=%s controls API and registry placement', async installed => {
  const config = { ...sample, plugins: sample.plugins!.filter(plugin => installed || plugin.name !== 'audit') }
  const app = createApp(config, runtime())
  expect((await request(app, '/audit/events')).status).toBe(installed ? 200 : 404)
  const response = await request(app, '/o/org-a/console-registry')
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  const registry = await response.json() as ReturnType<typeof consoleRegistry>
  expect(registry.pages.some(page => page.id === 'audit.activity')).toBe(installed)
  expect(registry.navigation.some(item => item.page === 'audit.activity')).toBe(installed)
  expect(registry.pages.some(page => page.id === 'core.workflows')).toBe(true)
})
it('fails startup clearly when audit requires console but it is absent', () => {
  expect(() => createApp({ ...sample, plugins: sample.plugins!.filter(plugin => plugin.name !== 'console') }, runtime()))
    .toThrow('Plugin audit: missing required contract console@^1')
})
it('a headless instance has neither a registry endpoint nor an audit endpoint', async () => {
  const config = { ...sample, plugins: sample.plugins!.filter(plugin => !['audit', 'console'].includes(plugin.name)) }
  const app = createApp(config, runtime())
  for (const path of ['/audit/events', '/o/org-a/console-registry']) expect((await request(app, path)).status).toBe(404)
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
  const response = await request(app, '/o/org-a/console-registry', 'GET', undefined, 'viewer-a')
  const registry = await response.json() as ReturnType<typeof consoleRegistry>
  expect(registry.pages.some(page => page.id === 'audit.activity')).toBe(false)
  expect(registry.navigation.some(item => item.page === 'audit.activity')).toBe(false)
  expect(registry.navigation.filter(item => item.entity).every(item => item.placement === 'sidebar')).toBe(true)
  expect((await request(app, '/o/org-b/console-registry', 'GET', undefined, 'owner-a')).status).toBe(403)
  expect((await app.request('/o/org-a/console-registry')).status).toBe(401)
})
it('carries existing model and field UI hints unchanged and merges display contributions', async () => {
  const fieldUi = { hidden: false, section: 'private' }
  const ui = { ...sample.ui, entities: { ...sample.ui?.entities, clients: { list: { columns: ['name'], search: ['name'] }, detail: { fields: ['name'] } } } }
  const config = { ...sample, ui, entities: { ...sample.entities, clients: { ...sample.entities.clients, fields: { ...sample.entities.clients.fields, name: { ...sample.entities.clients.fields.name, ui: fieldUi } } } }, plugins: [...sample.plugins!, {
    name: 'display-demo', version: '1', requires: { console: '^1' as const }, contributes: { console: {
      entities: { clients: { form: { create: { fields: ['name'] }, edit: { fields: ['name'] } }, sections: [{ id: 'main', label: 'Main', fields: ['name'] }] } },
      pages: [{ id: 'demo.custom', path: '/p/demo', label: 'Demo', renderer: 'members.list', grant: 'members.read' }],
      navigation: [{ id: 'demo.custom', placement: 'sidebar' as const, label: 'Demo', page: 'demo.custom', order: -1 }],
    } },
  }] }
  const response = await request(createApp(config, runtime()), '/o/org-a/console-registry')
  expect(response.status).toBe(200)
  const registry = await response.json() as ReturnType<typeof consoleRegistry>
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
  const app = createApp(config, runtime())
  const owner = await (await request(app, '/o/org-a/console-registry')).json() as ReturnType<typeof consoleRegistry>
  for (const id of ['owners', 'authorized-tokens', 'entity.named_clients']) expect(owner.navigation.some(item => item.id === id)).toBe(true)
  const viewer = await (await request(app, '/o/org-a/console-registry', 'GET', undefined, 'viewer-a')).json() as ReturnType<typeof consoleRegistry>
  for (const id of ['owners', 'authorized-tokens', 'entity.named_clients']) expect(viewer.navigation.some(item => item.id === id)).toBe(false)
  expect(viewer.navigation.some(item => item.group?.id === 'customers')).toBe(false)
})
