import { act, render, screen, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import type { ConsoleModelContract } from '@workbasehq/core/console-contract'
import { api } from '../src/api/client'
import { fetchCapabilities } from '../src/api/queries'
import { adaptConsoleModel, refreshRuntimeModel, useRuntimeModel } from '../src/api/runtime-model'
import { authorityGeneration, discardAuthority } from '../src/api/authority'
const doc = (): ConsoleModelContract => ({
  contractVersion: 1, console: { pages: [], navigation: [], entities: {} },
  model: { instance: 'test', revision: 1, entities: {}, commands: [], workflows: [], limits: {}, locale: 'en', timeZone: 'UTC' },
  capabilities: { revision: 1, organization: { role: 'admin' }, entities: {}, commands: [], workflows: {}, resources: { 'console.overview': true } },
})
afterEach(() => vi.unstubAllGlobals())
function Private() {
  const [draft, setDraft] = useState('')
  const row = useQuery({ queryKey: ['read', 'private'], queryFn: () => api<{ name: string }>('/query', { method: 'POST', orgId: 'A' }) })
  return <><p>{row.data?.name}</p><input aria-label="draft" value={draft} onChange={e => setDraft(e.target.value)} /></>
}
function Host() {
  const runtime = useRuntimeModel('A')
  return runtime.data ? <Private key={runtime.authorityGeneration} /> : <p>Authority unavailable</p>
}
it.each(['same-revision polling', 'grant-fetch failure', 'malformed grants', 'malformed runtime'] as const)('%s drops private rows/drafts/cursors and rejects a deferred old response', async trigger => {
  const previous = doc(), next = doc(); next.capabilities.organization.role = 'viewer'
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(['console-model', 'A'], adaptConsoleModel(previous)); client.setQueryData(['capabilities', 'A'], previous.capabilities)
  client.setQueryData(['read', 'private'], { name: 'Private row' }); client.setQueryData(['widget', 'A'], { cursor: 'private-cursor' })
  let release: ((response: Response) => void) | undefined, signal: AbortSignal | undefined
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    if (path.endsWith('/capabilities')) return Response.json(trigger === 'malformed grants' ? {} : next.capabilities, { status: trigger === 'grant-fetch failure' ? 500 : 200 })
    if (path.endsWith('/console-model')) return Response.json(trigger === 'malformed runtime' ? { ...next, capabilities: {} } : next)
    signal = init.signal!; return new Promise<Response>(resolve => { release = resolve })
  }))
  const view = render(<QueryClientProvider client={client}><Host /></QueryClientProvider>)
  fireEvent.change(screen.getByLabelText('draft'), { target: { value: 'Private draft' } })
  const pending = client.fetchQuery({ queryKey: ['late', 'A'], queryFn: () => api('/query', { method: 'POST', orgId: 'A' }) }).catch(error => error)
  // Invoke the same query function used by the existing 30-second poll/focus refresh.
  await act(async () => { await (trigger === 'malformed runtime' ? refreshRuntimeModel(client, 'A') : fetchCapabilities(client, 'A')).catch(() => {}) })
  expect(authorityGeneration(client, 'A')).toBeGreaterThan(0)
  expect(signal?.aborted).toBe(true)
  expect(screen.queryByText('Private row')).toBeNull(); expect(screen.queryByDisplayValue('Private draft')).toBeNull()
  expect(client.getQueryData(['widget', 'A'])).toBeUndefined()
  await act(async () => { release!(Response.json({ name: 'Obsolete bytes' })); await pending })
  expect(client.getQueryData(['late', 'A'])).toBeUndefined()
  expect(screen.queryByText('Obsolete bytes')).toBeNull()
  view.unmount(); client.clear()
})
it('organization A → B → A rejects old transports and cannot repopulate private caches', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const pending: { resolve: (r: Response) => void; signal: AbortSignal }[] = []
  vi.stubGlobal('fetch', vi.fn((_path: string, init: RequestInit) => new Promise<Response>(resolve => { pending.push({ resolve, signal: init.signal! }) })))
  const oldA = client.fetchQuery({ queryKey: ['read', 'A'], queryFn: () => api('/query', { orgId: 'A', method: 'POST' }) }).catch(error => error)
  discardAuthority(client, 'A')
  const oldB = client.fetchQuery({ queryKey: ['read', 'B'], queryFn: () => api('/query', { orgId: 'B', method: 'POST' }) }).catch(error => error)
  discardAuthority(client, 'B')
  const freshA = client.fetchQuery({ queryKey: ['read', 'A'], queryFn: () => api('/query', { orgId: 'A', method: 'POST' }) })
  expect(pending.map(p => p.signal.aborted)).toEqual([true, true, false])
  pending[2].resolve(Response.json({ name: 'Fresh A' })); await freshA
  pending[0].resolve(Response.json({ name: 'Old A' })); pending[1].resolve(Response.json({ name: 'Old B' })); await Promise.all([oldA, oldB])
  expect(client.getQueryData(['read', 'A'])).toEqual({ name: 'Fresh A' }); expect(client.getQueryData(['read', 'B'])).toBeUndefined()
  client.clear()
})

it('a cancelled old bootstrap cannot seed private metadata after a scope generation changes', async () => {
  const { bootstrapOptions } = await import('../src/api/bootstrap')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(['instance'], { instance: 'test', roles: [], locale: 'en' })
  let release: ((response: Response) => void) | undefined, signal: AbortSignal | undefined
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    if (path === '/me') { signal = init.signal!; return new Promise<Response>(resolve => { release = resolve }) }
    if (path === '/build.json') return Response.json({ revision: 1, sha: 'same', builtAt: 'now' })
    return Response.json(doc())
  }))
  const pending = client.fetchQuery(bootstrapOptions(client, 'A')).catch(error => error)
  discardAuthority(client, 'A')
  expect(signal?.aborted).toBe(true)
  release!(Response.json({ user: { id: 'actor' }, memberships: [] }))
  await pending
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  for (const key of ['bootstrap', 'workflow-schema', 'console-registry', 'capabilities']) expect(client.getQueryData([key, 'A'])).toBeUndefined()
  expect(client.getQueryData(['me'])).toBeUndefined()
  client.clear()
})

it('a retired mutation rejects JSON completion even when the fetch adapter ignores abort', async () => {
  let release: (value: unknown) => void = () => {}
  const json = new Promise(resolve => { release = resolve })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: () => json })))
  const client = new QueryClient()
  const pending = api('/api/probe/one', { orgId: 'A', method: 'PATCH', body: { name: 'Draft' } }).catch(error => error)
  await Promise.resolve()
  discardAuthority(client, 'A'); release({ id: 'one', name: 'Obsolete bytes' })
  expect(await pending).toMatchObject({ name: 'AbortError' })
  client.clear()
})

it('token create sends no POST after its downgrade preflight retires the private page', async () => {
  const { useTokenAction, tokenClient } = await import('../src/api/tokens')
  const previous = doc(), next = doc()
  previous.capabilities.resources = { 'tokens.read': true, 'tokens.create': true }
  next.capabilities.resources = { 'tokens.read': false, 'tokens.create': true }
  previous.console!.pages = [{ id: 'tokens', path: '/tokens', label: 'Tokens', grant: 'tokens.read', renderer: 'tokens' }]
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['capabilities', 'A'], previous.capabilities)
  client.setQueryData(['console-model', 'A'], adaptConsoleModel(previous))
  let authorize: ReturnType<typeof useTokenAction> = async () => {}, release: (r: Response) => void = () => {}
  const fetch = vi.fn(async (path: string) => {
    if (path.endsWith('/capabilities')) return new Promise<Response>(resolve => { release = resolve })
    if (path.endsWith('/console-model')) return Response.json(next)
    return Response.json({ token: 'synthetic' })
  })
  vi.stubGlobal('fetch', fetch)
  function TokenDraft() { authorize = useTokenAction('A'); return <p>Private token draft</p> }
  function TokenHost() {
    const runtime = useRuntimeModel('A')
    return runtime.data?.console.pages.some(page => page.id === 'tokens') ? <TokenDraft /> : <p>Retired private view</p>
  }
  const view = render(<QueryClientProvider client={client}><TokenHost /></QueryClientProvider>)
  const action = vi.fn(async () => { await tokenClient.create('A', { name: 'OLD DRAFT', role: 'viewer' }) })
  const pending = authorize('tokens.create', action).catch(error => error)
  await act(async () => { release(Response.json(next.capabilities)); await pending })
  expect(await pending).toMatchObject({ name: 'AbortError' })
  expect(authorityGeneration(client, 'A')).toBeGreaterThan(0)
  expect(screen.queryByText('Private token draft')).toBeNull()
  expect(fetch.mock.calls.map(([path]) => path)).toContain('/o/A/console-model')
  expect(action).not.toHaveBeenCalled()
  expect(fetch.mock.calls.map(([path]) => path)).not.toContain('/orgs/A/tokens')
  view.unmount(); client.clear()
})
