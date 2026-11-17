import type { ReactNode } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import i18next from 'i18next'
import type { ConsoleModelContract } from '@workbasehq/core/console-contract'
import { MembersScreen } from '../src/members'
import { WorkflowStart } from '../src/workflows'
import { RuntimeLocalization } from '../src/runtime-localization'
import { adaptConsoleModel } from '../src/api/runtime-model'
import { authorityGeneration, discardAuthority } from '../src/api/authority'
import en from '../src/locales/en.json'
const mocks = vi.hoisted(() => ({ navigate: vi.fn(async () => {}) }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate, Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a> }))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); mocks.navigate.mockClear() })
const document = (): ConsoleModelContract => ({
  contractVersion: 1, console: { pages: [], navigation: [], entities: {} },
  model: { instance: 'continuations', revision: 1, entities: {}, commands: [], workflows: [{ name: 'probe', version: '1', inputSchema: { type: 'object', properties: {} } }], limits: {}, locale: 'en', timeZone: 'UTC' },
  capabilities: { revision: 1, organization: { role: 'admin' }, entities: {}, commands: [], workflows: { probe: ['start'] }, resources: { 'members.read': true, 'invitations.read': true, 'invitations.create': true, 'workflows.read': true } },
})
async function setup(children: ReactNode) {
  const doc = document()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(['console-model', 'A'], adaptConsoleModel(doc)); client.setQueryData(['capabilities', 'A'], doc.capabilities)
  const me = { user: { id: 'actor', email: 'actor@example.test' }, memberships: [{ organization_id: 'A', name: 'A', role: 'admin' }], role: 'admin' }
  client.setQueryData(['organization', 'A'], me); client.setQueryData(['me'], me)
  const i18n = i18next.createInstance(); await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en } } })
  const view = () => render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><RuntimeLocalization orgId="A">{children}</RuntimeLocalization></QueryClientProvider></I18nextProvider>)
  return { doc, client, me, view }
}
const invitation = { id: 'pending', email: 'pending@example.test', role: 'admin', expires_at: '2099-01-01T00:00:00Z', accepted_at: null, revoked_at: null, actions: ['copy-link'] }
const delivery = { delivery: { status: 'failed', attempts: 1, sent_at: null, error: 'delivery_failed' } }
// Retire at the API-to-caller boundary: api() has checked JSON, but its caller
// has not resumed. Real action hooks and transport stay in the regression path.
function boundaryResponse(value: unknown, retire: () => void): Response {
  return { ok: true, status: 200, json: async () => {
    queueMicrotask(() => queueMicrotask(retire))
    return value
  } } as Response
}
it.each([false, true])('delivery retry continuation; retired=%s', async retire => {
  const test = await setup(<MembersScreen orgId="A" />)
  const requests: { path: string; generation: number; signal: AbortSignal }[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    requests.push({ path, generation: authorityGeneration(test.client, 'A'), signal: init.signal! })
    if (path.includes('/retry-delivery')) return boundaryResponse(delivery, () => { if (retire) discardAuthority(test.client, 'A') })
    if (path.endsWith('/delivery')) return Response.json(delivery)
    if (path.includes('/members?')) return Response.json({ data: [invitation], role_options: [{ id: 'admin', administrator: true }], default_role: 'admin' })
    if (path.endsWith('/capabilities')) return Response.json(test.doc.capabilities)
    if (path.endsWith('/console-model')) return Response.json(test.doc)
    if (path.startsWith('/me')) return Response.json(test.me)
    throw new Error(path)
  }))
  const view = test.view(); const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: /Actions.*pending@example.test/i }))
  await user.click(await screen.findByRole('menuitem', { name: en.inviteDelivery }))
  await user.click(await screen.findByRole('button', { name: en.inviteRetryDelivery }))
  await waitFor(() => expect(requests.some(r => r.path.endsWith('/retry-delivery'))).toBe(true))
  await waitFor(() => expect(test.client.getMutationCache().getAll().every(mutation => mutation.state.status !== 'pending')).toBe(true))
  if (retire) {
    expect(authorityGeneration(test.client, 'A')).toBe(1)
    expect(requests.filter(r => r.generation > 0)).toEqual([])
    expect(test.client.getQueryData(['workspace-identity', 'A', 'delivery', 'pending'])).toBeUndefined()
  } else {
    expect(requests.filter(r => r.path.endsWith('/delivery')).length).toBeGreaterThan(1)
    expect(test.client.getQueryData(['workspace-identity', 'A', 'delivery', 'pending'])).toEqual(delivery)
  }
  view.unmount(); test.client.clear()
})
it.each([false, true])('invitation credential copy continuation; retired=%s', async retire => {
  const test = await setup(<MembersScreen orgId="A" />)
  const clipboard = vi.fn(async () => {})
  const user = userEvent.setup(); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } })
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/copy-link')) return boundaryResponse({ accept_url: 'synthetic-invitation-credential' }, () => { if (retire) discardAuthority(test.client, 'A') })
    if (path.includes('/members?')) return Response.json({ data: [invitation], role_options: [{ id: 'admin', administrator: true }], default_role: 'admin' })
    if (path.endsWith('/capabilities')) return Response.json(test.doc.capabilities)
    if (path.endsWith('/console-model')) return Response.json(test.doc)
    if (path.startsWith('/me')) return Response.json(test.me)
    throw new Error(path)
  }))
  const view = test.view()
  await user.click(await screen.findByRole('button', { name: /Actions.*pending@example.test/i }))
  await user.click(await screen.findByRole('menuitem', { name: en.inviteCopy }))
  await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: en.inviteCopy }))
  await waitFor(() => expect(test.client.getMutationCache().getAll().every(mutation => mutation.state.status !== 'pending')).toBe(true))
  if (retire) { expect(authorityGeneration(test.client, 'A')).toBe(1); expect(clipboard).not.toHaveBeenCalled() }
  else expect(clipboard).toHaveBeenCalledWith('synthetic-invitation-credential')
  view.unmount(); test.client.clear()
})
it.each([false, true])('workflow start completion after list refresh; retired=%s', async retire => {
  const test = await setup(<WorkflowStart orgId="A" />)
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    if (path.endsWith('/capabilities')) return Response.json(test.doc.capabilities)
    if (path.endsWith('/console-model')) return Response.json(test.doc)
    if (path.startsWith('/me')) return Response.json(test.me)
    if (path === '/workflows/probe' && init.method === 'POST') return Response.json({ id: 'created-under-starting-authority' })
    if (path.startsWith('/workflows')) return Response.json({ data: [] })
    throw new Error(path)
  }))
  let release = () => {}; const waiting = new Promise<void>(resolve => { release = resolve })
  const invalidate = test.client.invalidateQueries.bind(test.client)
  const refresh = vi.spyOn(test.client, 'invalidateQueries').mockImplementation((...args) => args[0]?.queryKey?.[0] === 'workflow-runs' ? waiting : invalidate(...args))
  const view = test.view()
  const start = await screen.findByRole('button', { name: en.workflowStart })
  fireEvent.submit(start.closest('form')!)
  await waitFor(() => expect(refresh).toHaveBeenCalledWith({ queryKey: ['workflow-runs', 'A'] }))
  await act(async () => { if (retire) discardAuthority(test.client, 'A'); release(); await waiting })
  await waitFor(() => expect(test.client.getMutationCache().getAll().every(mutation => mutation.state.status !== 'pending')).toBe(true))
  if (retire) expect(mocks.navigate).not.toHaveBeenCalled()
  else expect(mocks.navigate).toHaveBeenCalledWith({ to: '/o/$orgId/settings/workflows/$id', params: { orgId: 'A', id: 'created-under-starting-authority' } })
  view.unmount(); test.client.clear()
})
