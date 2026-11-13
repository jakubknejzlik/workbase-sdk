// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement as h } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { AccessCard, ConsoleProvider, PageView, useRuntime, type AccessBinding } from '../src/react'
import { createI18n } from '../src/i18n'
import { entityDetailPage, p, slot } from '../src/index'
import { grants } from './grants'
import type { Client, ClientRequestInit } from '../src/client'
import noAccount from '../../../../core/test/fixtures/worker-access/detail.no_account.json'
import invited from '../../../../core/test/fixtures/worker-access/detail.invited.json'
import expired from '../../../../core/test/fixtures/worker-access/detail.expired.json'
import linked from '../../../../core/test/fixtures/worker-access/detail.linked.json'
const fixtures = [noAccount, invited, expired, linked]
const names = ['invite', 'cancel_invite', 'link_account', 'unlink_account']
const json = (body: unknown) => new Response(JSON.stringify(body))
const t = (key: string) => key
const meta = { displayField: 'name', fields: { name: { type: 'text', required: true, readOnly: false, computed: false, userLink: false }, user: { type: 'ref', required: false, readOnly: false, computed: false, userLink: true } } }
afterEach(() => { cleanup(); vi.restoreAllMocks() })
test.each(['cs', 'en'])('four committed server fixtures agree exactly with controls and reasons in %s', language => {
  const i18n = createI18n({ languages: [language], catalogs: {} })
  for (const fixture of fixtures) {
    const access = { state: fixture.access, actions: fixture.actions, run: vi.fn(), candidates: vi.fn() } as AccessBinding
    const mounted = render(h(AccessCard, { access, t: i18n.t }))
    for (const name of names) {
      const action = fixture.actions[name as keyof typeof fixture.actions], button = screen.getByRole('button', { name: i18n.t('sdk:card.' + name) })
      expect(button.hasAttribute('disabled')).toBe(!action.enabled)
      if ('reason' in action) expect(screen.getAllByText(i18n.t('sdk:' + action.reason)).length).toBeGreaterThan(0)
    }
    expect(screen.getAllByRole('button')).toHaveLength(names.length)
    expect((mounted.container as unknown as { textContent: string }).textContent).not.toMatch(/⟦|⟧/)
    expect((mounted.container as unknown as { textContent: string }).textContent).toContain(i18n.t('sdk:card.membershipStays'))
    mounted.unmount()
  }
})
function view(options: { fetch?: (url: string, init: ClientRequestInit) => Promise<Response>; component?: (...args: any[]) => any; entity?: string; readable?: string[]; members?: boolean; extra?: unknown } = {}) {
  const entity = options.entity ?? 'probe', entities = { [entity]: meta }, definition = entityDetailPage(entity, { title: 'page.detail', recordParam: 'assetId', layout: [slot('accessCard', { account: 'user' })] })
  const caps = grants(entities); caps.resources['members.read'] = options.members ?? true
  if (options.readable) caps.entities[entity].readable = options.readable
  return h(ConsoleProvider, { identity: { actorId: 'actor', orgId: 'org' }, t, caps, fetch: options.fetch ?? (async () => json(noAccount)), slots: { accessCard: { contexts: ['record'], props: { account: p.field('userLink'), access: p.access() }, component: options.component ?? AccessCard } } }, h(PageView, { definition, route: { ...definition, path: '/assets/$assetId', source: 'ui/items.ts', links: {} }, entities, params: { assetId: 'wrk_1' }, search: {}, navigate: () => {} }), options.extra as never)
}
test('slot spy gets exactly declared props plus t; masked field omits it and absent access cannot fetch members', async () => {
  const spy = vi.fn((props: Parameters<typeof AccessCard>[0]) => h(AccessCard, props)), fetch = vi.fn(async () => json(noAccount))
  render(view({ component: spy, fetch })); await screen.findByText('sdk:card.no_account')
  const props = spy.mock.calls.at(-1)![0]
  expect(Object.keys(props).sort()).toEqual(['access', 'account', 't'])
  expect(Object.keys(props.access!).sort()).toEqual(['actions', 'candidates', 'run', 'state'])
  expect(props.account).toBeNull(); expect(fetch).toHaveBeenCalledTimes(1)
  cleanup(); spy.mockClear(); fetch.mockClear()
  render(view({ component: spy, fetch, readable: ['id', 'name'] })); await screen.findByRole('heading')
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1)); expect(spy).not.toHaveBeenCalled()
  cleanup(); fetch.mockImplementation(async () => json({ id: 'wrk_1', version: 3, user: null, actions: {} })); fetch.mockClear()
  render(view({ component: spy, fetch })); await waitFor(() => expect(spy).toHaveBeenCalled())
  expect(spy.mock.calls.at(-1)![0].access).toBeUndefined(); expect(screen.queryByText('sdk:card.title')).toBeNull(); expect(fetch).toHaveBeenCalledTimes(1)
})
test('candidate source is lazy and requires the members.read resource grant', async () => {
  const fetch = vi.fn(async (url: string) => json(url.endsWith('/members') ? { data: [{ user_id: 'account', email: 'account@example.test', role: 'admin' }] } : noAccount))
  render(view({ fetch })); await screen.findByText('sdk:card.no_account'); expect(fetch).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'sdk:card.link_account' }))
  const select = await screen.findByLabelText('sdk:card.account')
  expect(fetch.mock.calls[1][0]).toBe('/orgs/org/members'); expect(screen.queryByRole('textbox', { name: 'sdk:card.account' })).toBeNull()
  fireEvent.change(select, { target: { value: 'account' } })
  cleanup(); fetch.mockClear(); render(view({ fetch, members: false })); await screen.findByText('sdk:card.no_account')
  expect(screen.getByRole('button', { name: 'sdk:card.link_account' }).hasAttribute('disabled')).toBe(true); expect(fetch).toHaveBeenCalledTimes(1)
})
test('synthetic second entity uses actWith, reseeds the detail, and confines the outbox credential to component state', async () => {
  let server: unknown = noAccount, client: Client | undefined
  function Inspector() { client = useRuntime().client; return null }
  const fetch = vi.fn(async (url: string, init: ClientRequestInit) => {
    if (url.endsWith('/actions/invite')) { server = invited; return json({ invitation_id: 'inv', expires_at: 'soon', accept_url: 'https://example.test/invitations/accept?token=synthetic-secret' }) }
    return json(server)
  })
  const mounted = render(view({ fetch, entity: 'fleet', extra: h(Inspector) }))
  await screen.findByText('sdk:card.no_account'); fireEvent.change(screen.getByLabelText('sdk:card.email'), { target: { value: ' outbox@example.test ' } })
  fireEvent.click(screen.getByRole('button', { name: 'sdk:card.invite' }))
  const outbox = await screen.findByLabelText('sdk:card.outbox')
  expect(outbox.getAttribute('value')).toBe('https://example.test/invitations/accept?token=synthetic-secret')
  await screen.findByText('sdk:card.invited')
  const write = fetch.mock.calls.find(([url]) => url.endsWith('/actions/invite'))!
  expect(write[0]).toBe('/api/fleet/wrk_1/actions/invite'); expect(JSON.parse(String(write[1].body))).toEqual({ email: 'outbox@example.test' })
  const cached = await client!.one('fleet', { id: 'wrk_1' }, new AbortController().signal)
  expect(cached).toEqual(invited); expect(JSON.stringify(cached)).not.toContain('synthetic-secret')
  const writeText = vi.fn(async () => {})
  const navigator = (globalThis as unknown as { navigator: object }).navigator
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  fireEvent.click(screen.getByRole('button', { name: 'sdk:card.copy' })); await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://example.test/invitations/accept?token=synthetic-secret'))
  mounted.unmount(); render(view({ fetch, entity: 'fleet' })); await screen.findByText('sdk:card.invited'); expect(screen.queryByLabelText('sdk:card.outbox')).toBeNull()
})
test('card follows new server props, only own action keys render, and custom reasons use ui', async () => {
  const binding = { state: linked.access, actions: { unlink_account: { enabled: false, reason: 'custom.blocked' } }, run: vi.fn() } as AccessBinding
  const mounted = render(h(AccessCard, { t, access: binding })); expect(screen.getByText('ui:custom.blocked')).toBeTruthy()
  expect(screen.getAllByRole('button')).toHaveLength(1)
  mounted.rerender(h(AccessCard, { t, access: { ...binding, state: noAccount.access as AccessBinding['state'], actions: {} } }))
  expect(screen.getByText('sdk:card.no_account')).toBeTruthy(); expect(screen.queryByText('sdk:card.linked')).toBeNull()
  mounted.rerender(h(AccessCard, { t })); expect(screen.queryByText('sdk:card.title')).toBeNull()
})
test('SDK React sources have no entity-name branches or identity-keyed/global credential stores', () => {
  const files = readdirSync(resolve('packages/plugins/console/ui/src/react'))
  const text = files.map(file => readFileSync(resolve('packages/plugins/console/ui/src/react', file), 'utf8')).join('\n')
  expect(text).not.toMatch(/worker/i); expect(text).not.toMatch(/WeakMap|WeakSet|localStorage|sessionStorage/)
})
