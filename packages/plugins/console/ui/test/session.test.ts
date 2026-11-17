// @vitest-environment jsdom
import { createElement as h, useEffect } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { ConsoleProvider, PageView, Session, Shell, useRuntime } from '../src/react'
import { gate, parseCapabilities, type Capabilities } from '../src/gate'
import { canonicalJSON, diff, type ClientRequestInit } from '../src/client'
import { entityCreatePage, entityDetailPage, entityEditPage, entityListPage, page, type Page } from '../src/index'
import type { Manifest } from '../src/check'
import { grants } from './grants'
const metadata = { displayField: 'name', fields: Object.fromEntries(['name', 'secret', 'locked'].map(name => [name, { type: 'text', required: name === 'name', readOnly: false, userLink: false, computed: false }])) }
const entities = { probe: metadata }
const admin = grants(entities)
const staff = { ...admin, organization: { role: 'staff' }, entities: { probe: { operations: ['read'], readable: ['id', 'name', 'locked'], writable: [] } } }
const row = { id: 'x', version: 1, name: 'Visible', secret: 'foreign bytes', locked: 'Read only', actions: {} }
const definitions = [entityListPage('probe', { title: 'items.list', layout: ['name', 'secret'] }), entityCreatePage('probe', { title: 'items.new', layout: ['name'] }), entityDetailPage('probe', { title: 'items.detail', recordParam: 'itemId', layout: ['name', 'secret'] }), entityEditPage('probe', { title: 'items.edit', recordParam: 'itemId', layout: ['name', 'locked', 'secret'] })]
const routes = definitions.map((definition, index) => ({ ...definition, source: 'ui/items.ts', path: ['/items', '/items/new', '/items/$itemId', '/items/$itemId/edit'][index], links: { list: { to: '/items', bind: {} }, detail: { to: '/items/$itemId', bind: { itemId: 'record.id' } }, edit: { to: '/items/$itemId/edit', bind: { itemId: 'record.id' } } } }))
const manifest: Manifest = { version: 3, configHash: 'test', entities, keys: {}, slots: {}, routes, nav: [{ title: 'items.list', link: { to: '/items', bind: {} } }, { title: 'items.edit', link: { to: '/items/new', bind: {} } }] }
const document = (globalThis as unknown as { document: Document & { activeElement: unknown } }).document
const t = (key: string) => key
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const me = { actor: { id: 'a' }, memberships: [{ organization_id: 'one' }] }
function content(mode: Page['mode'] = 'list') {
  const route = routes.find(route => route.mode === mode)!
  return h(Shell, { manifest }, h(PageView, { definition: route, route, routes, entities, params: { itemId: 'x' }, search: {}, navigate: () => {} }))
}
function mount(fetch: (url: string, init: ClientRequestInit) => Promise<Response>, mode: Page['mode'] = 'list', orgId = 'one', timeoutMs = 10000) {
  return h(Session, { orgId, t, fetch, timeoutMs }, content(mode))
}
afterEach(() => { cleanup(); vi.restoreAllMocks() })
test('one gate denies absent entity/key and survives JSON/structuredClone with stable canonical key', () => {
  for (const caps of [undefined, { ...admin, entities: {} }, { ...admin, entities: { probe: {} } }] as (Capabilities | undefined)[]) for (const definition of definitions) expect(gate(caps, manifest).allows(definition)).toBe(false)
  const cloned = structuredClone(JSON.parse(JSON.stringify(admin)))
  expect(gate(cloned, manifest).allows(routes[0])).toBe(true)
  expect(canonicalJSON(['a', 'one', cloned])).toBe(canonicalJSON(['a', 'one', admin]))
  expect(canonicalJSON(['a', 'one', { ...admin, revision: 2 }])).not.toBe(canonicalJSON(['a', 'one', admin]))
  expect(gate({ ...admin, entities: { constructor: {} } }, manifest).readable('toString', 'id')).toBe(false)
  expect(() => parseCapabilities({ entities: {} })).toThrow()
  expect(diff(metadata, ['name', 'locked'], { name: 'A', locked: 'keep' }, { name: 'B', locked: 'forged' }, ['name'])).toEqual({ name: 'B' })
})
test.each(['500', 'timeout', 'json', 'shape'])('capability %s fails closed with retry only and zero data calls', async failure => {
  const fetch = vi.fn(async (url: string) => {
    if (url === '/me') return json(me)
    if (failure === 'timeout') return new Promise<Response>(() => {})
    if (failure === 'json') return new Response('{')
    return json(failure === 'shape' ? {} : { error: 'bad' }, failure === '500' ? 500 : 200)
  })
  render(mount(fetch, 'list', 'one', failure === 'timeout' ? 10 : 10000))
  await screen.findByText('sdk:failed')
  expect(screen.getAllByRole('button')).toHaveLength(1); expect(screen.getByText('sdk:retry')).toBeTruthy()
  expect(screen.queryByRole('navigation')).toBeNull(); expect(fetch).toHaveBeenCalledTimes(2)
})
test('parallel me/caps boot, no-store, retry, 401 and missing membership terminal states', async () => {
  const pending: ((r: Response) => void)[] = []
  const fetch = vi.fn((_url: string, _init: ClientRequestInit) => new Promise<Response>(resolve => pending.push(resolve)))
  const mounted = render(mount(fetch))
  expect(fetch).toHaveBeenCalledTimes(2); expect(screen.queryByRole('navigation')).toBeNull()
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/me', '/o/one/capabilities'])
  expect(fetch.mock.calls.every(([, init]) => init.cache === 'no-store' && init.credentials === 'same-origin')).toBe(true)
  await act(async () => { pending[0](json(me)); pending[1](json({}, 500)) })
  fireEvent.click(await screen.findByText('sdk:retry')); expect(fetch).toHaveBeenCalledTimes(4)
  await act(async () => { pending[2](json({ ...me, memberships: [] })); pending[3](json({}, 403)) })
  await screen.findByText('sdk:removed'); expect(screen.queryByRole('navigation')).toBeNull(); mounted.unmount()
  render(mount(async url => json(url === '/me' ? {} : admin, url === '/me' ? 401 : 200)))
  await screen.findByText('sdk:unauthenticated'); expect(screen.queryByRole('navigation')).toBeNull()
})
test.each(['create', 'edit'] as const)('direct denied %s URL never mounts a data observer', async mode => {
  const fetch = vi.fn(async (url: string) => json(url === '/me' ? me : staff))
  render(mount(fetch, mode)); await screen.findByText('sdk:forbidden')
  expect(fetch).toHaveBeenCalledTimes(2); expect(screen.queryByText('foreign bytes')).toBeNull()
  expect(screen.queryByText('sdk:create')).toBeNull(); expect(screen.queryByText('sdk:edit')).toBeNull()
})
test('readable nonwritable fields are text, masks omit fields, list select and sort intersect readable', async () => {
  const caps = { ...admin, entities: { probe: { ...admin.entities.probe, writable: ['name'], readable: ['id', 'name', 'locked'] } } }
  const fetch = vi.fn(async (_url: string, _init: ClientRequestInit) => json(row))
  const mounted = render(h(ConsoleProvider, { identity: { actorId: 'a', orgId: 'one' }, caps, t, fetch }, content('edit')))
  await screen.findByLabelText('domain:field.probe.name'); expect(screen.queryByLabelText('domain:field.probe.locked')).toBeNull()
  expect(screen.getByText('Read only')).toBeTruthy(); expect(screen.queryByText('foreign bytes')).toBeNull(); mounted.unmount()
  fetch.mockImplementation(async () => json({ data: [row], next_cursor: null })); fetch.mockClear()
  render(h(ConsoleProvider, { identity: { actorId: 'a', orgId: 'one' }, caps: staff, t, fetch }, content()))
  await screen.findAllByText('Visible')
  const request = JSON.parse(String(fetch.mock.calls[0][1].body))
  expect(request.select).toEqual(['id', 'name', 'locked']); expect(request.orderBy).toEqual([{ field: 'name', dir: 'asc' }])
  expect(screen.queryByRole('option', { name: 'domain:field.probe.secret' })).toBeNull()
  expect(screen.queryByText('foreign bytes')).toBeNull()
})
test.each(['403', 'visibility'])('%s refresh purges admin cache and removes controls on demotion', async trigger => {
  let demoted = false
  const fetch = vi.fn(async (url: string, init: ClientRequestInit) => url === '/me' ? json(me) : url.includes('capabilities') ? json(demoted ? staff : admin) : init.method === 'PATCH' ? json({ error: 'forbidden' }, 403) : json(url === '/query' ? { data: [{ ...row, name: demoted ? 'Staff row' : 'Admin row' }], next_cursor: null } : row))
  const mounted = render(mount(fetch))
  await screen.findAllByText('Admin row'); expect(screen.getByText('sdk:create')).toBeTruthy()
  if (trigger === '403') {
    mounted.rerender(mount(fetch, 'edit'))
    fireEvent.change(await screen.findByLabelText('domain:field.probe.name'), { target: { value: 'Save' } })
    demoted = true; fireEvent.click(screen.getByText('sdk:save')); await screen.findByText('sdk:forbidden')
    mounted.rerender(mount(fetch))
  } else {
    demoted = true
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    fireEvent(document, new Event('visibilitychange'))
  }
  await screen.findAllByText('Staff row')
  expect(screen.queryByText('Admin row')).toBeNull(); expect(screen.queryByText('sdk:create')).toBeNull()
  expect(fetch.mock.calls.filter(([url]) => url.includes('capabilities'))).toHaveLength(2)
  expect(fetch.mock.calls.filter(([url]) => url === '/query')).toHaveLength(2)
})
test('async persistent read 403 with unchanged capabilities settles forbidden after one recovery', async () => {
  let boots = 0
  const fetch = vi.fn(async (url: string) => {
    // Real asynchronous I/O lets loading commit and unmount the provider between boots.
    await new Promise(resolve => setTimeout(resolve, 5))
    if (url === '/me') return json(me)
    // Equivalent documents with a different property order still describe the same scope.
    if (url.includes('/capabilities')) return json(++boots === 1 ? admin : Object.fromEntries(Object.entries(admin).reverse()))
    return json({ error: 'forbidden' }, 403)
  })
  render(mount(fetch, 'detail'))
  await screen.findByText('sdk:forbidden')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)) })
  expect(screen.getByText('sdk:forbidden')).toBeTruthy()
  expect(screen.queryByText('sdk:loading')).toBeNull()
  for (const path of ['/me', '/o/one/capabilities', '/api/probe/x']) {
    const calls = fetch.mock.calls.filter(([url]) => url === path)
    expect(calls.length).toBeGreaterThan(0); expect(calls.length).toBeLessThanOrEqual(2)
  }
  expect(boots).toBe(2)
})
test('async capabilities changing after a 403 rearm recovery and mount fresh clients', async () => {
  let boots = 0, reads = 0
  const mounts: ReturnType<typeof useRuntime>[] = []
  function View() {
    const runtime = useRuntime()
    useEffect(() => { mounts.push(runtime) }, [runtime.client])
    return content('detail')
  }
  const changed = { ...admin, revision: 2 }
  const fetch = vi.fn(async (url: string) => {
    await new Promise(resolve => setTimeout(resolve, 5))
    if (url === '/me') return json(me)
    if (url.includes('/capabilities')) return json(++boots === 1 ? admin : changed)
    return ++reads <= 2 ? json({ error: 'forbidden' }, 403) : json({ ...row, name: 'Fresh scope' })
  })
  render(h(Session, { orgId: 'one', t, fetch }, h(View)))
  await screen.findByText('Fresh scope')
  expect(boots).toBe(3); expect(reads).toBe(3)
  expect(mounts).toHaveLength(3)
  expect(new Set(mounts.map(runtime => runtime.client)).size).toBe(3)
  expect(mounts.map(runtime => runtime.caps)).toEqual([admin, changed, changed])
})
test.each(['unauthenticated', 'removed'])('async 403 recovery preserves terminal %s state', async terminal => {
  let boots = 0
  const fetch = vi.fn(async (url: string) => {
    await new Promise(resolve => setTimeout(resolve, 5))
    if (url === '/me') return ++boots === 1 ? json(me) : terminal === 'removed' ? json({ ...me, memberships: [] }) : json({}, 401)
    return url.includes('/capabilities') ? json(admin) : json({ error: 'forbidden' }, 403)
  })
  render(mount(fetch, 'detail'))
  await screen.findByText('sdk:' + terminal)
  expect(screen.queryByRole('navigation')).toBeNull()
  expect(boots).toBe(2)
  expect(fetch.mock.calls.filter(([url]) => url === '/api/probe/x')).toHaveLength(1)
})
test('explicit retry rearms recovery after a failed 403 boot with unchanged scope', async () => {
  let boots = 0
  const fetch = vi.fn(async (url: string) => {
    await new Promise(resolve => setTimeout(resolve, 5))
    if (url === '/me') return json(me)
    if (url.includes('/capabilities')) return ++boots === 2 ? json({}, 500) : json(admin)
    return json({ error: 'forbidden' }, 403)
  })
  render(mount(fetch, 'detail'))
  fireEvent.click(await screen.findByText('sdk:retry'))
  await screen.findByText('sdk:forbidden')
  expect(boots).toBe(4)
  expect(fetch.mock.calls.filter(([url]) => url === '/api/probe/x')).toHaveLength(3)
})
test('data 401 unmounts everything; failed visibility refresh hides an old ready view', async () => {
  let failed = false
  const fetch = vi.fn(async (url: string) => json(url === '/me' ? me : url.includes('capabilities') ? admin : {}, url.includes('capabilities') && failed ? 500 : url.startsWith('/api') ? 401 : 200))
  render(mount(fetch, 'detail')); await screen.findByText('sdk:unauthenticated'); expect(screen.queryByRole('navigation')).toBeNull()
  cleanup()
  const visible = vi.fn(async (url: string) => json(url === '/me' ? me : url.includes('capabilities') ? admin : { data: [row], next_cursor: null }, failed ? 500 : 200))
  render(mount(visible)); await screen.findAllByText('Visible'); failed = true
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); fireEvent(document, new Event('visibilitychange'))
  await screen.findByText('sdk:failed'); expect(screen.queryByText('Visible')).toBeNull(); expect(screen.queryByRole('navigation')).toBeNull()
})
test('disclosure supports tap, Escape and focus return; nav excludes forbidden targets', async () => {
  render(mount(async url => json(url === '/me' ? me : url.includes('capabilities') ? staff : { data: [], next_cursor: null })))
  const button = await screen.findByText('sdk:navigation')
  // jsdom has no mobile media-query layout; Chromium covers the real 390px CSS.
  ;(button as unknown as { style: { display: string } }).style.display = 'block'
  expect(button.getAttribute('aria-expanded')).toBe('false'); fireEvent.click(button)
  expect(button.getAttribute('aria-expanded')).toBe('true')
  const link = screen.getByRole('link', { name: 'ui:items.list' }); (link as unknown as { focus(): void }).focus()
  fireEvent.keyDown(link, { key: 'Escape' }); expect(button.getAttribute('aria-expanded')).toBe('false'); expect(document.activeElement).toBe(button)
  expect(screen.queryByRole('link', { name: 'ui:items.edit' })).toBeNull()
})
test('actions use exact own keys from the detail with a translated disabled reason', async () => {
  const detail = { ...routes[2], layout: [{ kind: 'action' as const, name: 'allowed' }, { kind: 'action' as const, name: 'missing' }, { kind: 'action' as const, name: 'constructor' }] }
  const fetch = vi.fn(async () => json({ ...row, actions: { allowed: { enabled: false, reason: 'items.pending' } } }))
  render(h(ConsoleProvider, { identity: { actorId: 'a', orgId: 'one' }, caps: staff, t, fetch }, h(PageView, { definition: detail, route: detail, routes, entities, params: { itemId: 'x' }, search: {}, navigate: () => {} })))
  expect((await screen.findByText('ui:actions.allowed')).hasAttribute('disabled')).toBe(true); expect(screen.getByText('ui:items.pending')).toBeTruthy()
  expect(screen.queryByText('ui:actions.missing')).toBeNull(); expect(screen.queryByText('ui:actions.constructor')).toBeNull()
})
test.each(['unauthenticated', 'removed'])('%s does not wait for a hung parallel boot request', async terminal => {
  const fetch = vi.fn(async (url: string) => url !== '/me' ? new Promise<Response>(() => {}) : terminal === 'removed' ? json({ ...me, memberships: [] }) : json({}, 401))
  render(mount(fetch)); await screen.findByText('sdk:' + terminal)
  expect(fetch).toHaveBeenCalledTimes(2); expect(screen.queryByRole('navigation')).toBeNull()
})
test('same-role resource or revision changes replace the cache; late org-A boot cannot mount inside org B', async () => {
  const pending: { url: string; resolve: (response: Response) => void }[] = []
  const fetch = vi.fn((url: string, _init: ClientRequestInit) => new Promise<Response>(resolve => pending.push({ url, resolve })))
  const mounted = render(mount(fetch))
  mounted.rerender(mount(fetch, 'list', 'two'))
  await act(async () => { pending[2].resolve(json({ ...me, memberships: [{ organization_id: 'two' }] })); pending[3].resolve(json(staff)) })
  await waitFor(() => expect(pending).toHaveLength(5))
  await act(async () => { pending[4].resolve(json({ data: [], next_cursor: null })); pending[0].resolve(json(me)); pending[1].resolve(json(admin)) })
  await screen.findByText('sdk:empty'); expect(screen.queryByText('sdk:create')).toBeNull()
  mounted.unmount()
  for (const change of [{ ...admin, resources: { 'members.read': true } }, { ...admin, revision: 2 }]) {
    const transport = vi.fn(async () => json({ data: [{ ...row, name: 'Fresh' }], next_cursor: null }))
    const host = render(h(ConsoleProvider, { identity: { actorId: 'a', orgId: 'one' }, caps: admin, t, fetch: transport }, content()))
    await screen.findAllByText('Fresh'); host.rerender(h(ConsoleProvider, { identity: { actorId: 'a', orgId: 'one' }, caps: change, t, fetch: transport }, content()))
    await waitFor(() => expect(transport).toHaveBeenCalledTimes(2)); host.unmount()
  }
})
