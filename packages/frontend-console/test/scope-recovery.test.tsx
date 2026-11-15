import { afterEach, expect, it, vi } from 'vitest'
import { render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { ScopeHomeContext, scopeHomeDestination } from '../../console-generated/src/scope-home'
import { GeneratedReadPage } from '../../console-generated/src/screens'
import type { Model, Capabilities } from '../../console-generated/src/read'
import { Failure } from '../src/screens'
import { AcceptInvitation } from '../src/accept-invitation'
import { authDestination } from '../src/api/auth-destination'
import { safeReturnTo, signInLocation } from '../src/api/client'
import { useInvitationDestination } from '../src/api/invitation-destination'
import type { Me } from '../src/api/queries'
import type { ReactNode } from 'react'

afterEach(() => { vi.unstubAllGlobals() })
const membership = (id: string) => ({ organization_id: id, name: id, role: 'admin' })
const cases = [
  { name: 'Members only', organizationsEnabled: false, memberships: [membership('instance')], home: '/o/instance' },
  { name: 'one organization', organizationsEnabled: true, memberships: [membership('org-a')], home: '/o/org-a' },
  { name: 'multiple organizations', organizationsEnabled: true, memberships: [membership('org-a'), membership('org-b')], home: '/organizations' },
  { name: 'organization creation', organizationsEnabled: true, memberships: [], home: '/organizations' },
]
it.each(cases)('$name keeps its home for authentication and recovery', ({ memberships, organizationsEnabled, home }) => {
  expect(scopeHomeDestination({ memberships, organizationsEnabled })).toBe(home)
  for (const saved of [null, '/', '/organizations', 'https://outside.test', '/unrecognized']) {
    expect(authDestination(saved, memberships, undefined, organizationsEnabled)).toBe(home)
  }
  expect(authDestination('/o/org-a/e/tasks', memberships, undefined, organizationsEnabled)).toBe('/o/org-a/e/tasks')
})
it('uses the active scope without Organizations and safely encodes scope IDs', () => {
  expect(scopeHomeDestination({ organizationsEnabled: false, memberships: [membership('a'), membership('b')] }, 'b')).toBe('/o/b')
  expect(scopeHomeDestination({ organizationsEnabled: false, memberships: [] })).toBe('/organizations')
  expect(scopeHomeDestination({ memberships: [membership('scope name')] })).toBe('/o/scope%20name')
})
it('rejects unsafe return paths into a scope-aware fallback and preserves invitation returns', () => {
  for (const value of [null, '//outside.test/o/instance', '/o/%2foutside', '/o/%5coutside', '/o/instance\n', '/o/instance\\other', '/invitation?token=secret']) {
    expect(safeReturnTo(value, '/o/instance')).toBe('/o/instance')
  }
  expect(safeReturnTo(null)).toBe('/')
  expect(signInLocation('https://outside.test')).toBe('/sign-in?returnTo=%2F')
  expect(safeReturnTo('/invitation?id=opaque-id')).toBe('/invitation?id=opaque-id')
})
it('an expired invitation return recovers to the scope while Organizations retains its chooser', () => {
  const inbox = { data: [], next: '/organizations' }
  expect(authDestination('/invitation?id=gone', [membership('instance')], inbox, false)).toBe('/o/instance')
  expect(authDestination('/invitation?id=gone', [membership('a'), membership('b')], inbox, true)).toBe('/organizations')
})
it('the neutral post-sign-in landing still discovers pending invitations before organization creation', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ id: 'pending', navigation_target: '/invitation?id=pending' }], next: '/invitation?id=pending' })))
  const { result } = renderHook(() => useInvitationDestination('/', [], true), { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> })
  await waitFor(() => expect(result.current.target).toBe('/invitation?id=pending'))
  client.clear()
})

async function mount(content: ReactNode, me: Pick<Me, 'memberships' | 'organizationsEnabled'>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(['me'], me)
  const root = createRootRoute()
  const route = createRoute({ getParentRoute: () => root, path: '/o/$orgId/', component: () => <ScopeHomeContext.Provider value={scopeHomeDestination(me, 'instance')}>{content}</ScopeHomeContext.Provider> })
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ['/o/instance'] }) })
  await router.load()
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return client
}

it.each(cases)('not-found page recovers correctly for $name', async ({ home, ...me }) => {
  const client = await mount(<Failure kind="notFound" />, me)
  expect((await screen.findByRole('link')).getAttribute('href')).toBe(home)
  client.clear()
})

it.each(cases)('missing generated record recovers correctly for $name', async ({ home, ...me }) => {
  const model = { instance: 'test', limits: { root: 100, children: 100, relations: 4, exists: 4 }, entities: { tasks: { fields: { id: { type: 'string' } }, columns: ['id'], relations: {} } } } as unknown as Model
  const caps = { revision: 1, entities: { tasks: { readable: ['id'], writable: [], operations: ['read'] } } } as Capabilities
  const client = await mount(<GeneratedReadPage model={model} caps={caps} orgId="instance" entity="tasks" id="missing" request={async () => ({ data: [], next_cursor: null })} />, me)
  expect((await screen.findByRole('link', { name: home === '/organizations' ? 'organizations' : 'overview' })).getAttribute('href')).toBe(home)
  client.clear()
})

it.each(cases)('invitation recovery goes home for $name', async ({ home, ...me }) => {
  const replace = vi.fn()
  const originalWindow = window
  vi.stubGlobal('window', new Proxy(originalWindow, { get: (target, key) => key === 'location' ? { ...target.location, search: '', replace } : Reflect.get(target, key) }))
  const client = await mount(<AcceptInvitation />, me)
  client.setQueryData(['profile'], { completeness: { complete: true } })
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ completeness: { complete: true } })))
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'p10GoHome' }))
  await waitFor(() => expect(replace).toHaveBeenCalledWith(home))
  client.clear()
})
