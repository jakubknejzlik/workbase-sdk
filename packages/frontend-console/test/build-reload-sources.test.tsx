import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { MutationSession, getMutationSafetySnapshot, subscribeMutationSafety, useMutationForm } from '@workbasehq/ui'
import { buildReload, createBuildReloadCoordinator } from '../src/build-reload'
import { fetchCapabilities, useBuild } from '../src/api/queries'
import { bootstrapOptions } from '../src/api/bootstrap'

const dispose: (() => void)[] = []
afterEach(() => { dispose.splice(0).forEach(fn => fn()); focusManager.setFocused(undefined); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function setup() {
  const tasks = new Set<() => void>(), reload = vi.fn(), storage = new Map<string, string>()
  const coordinator = createBuildReloadCoordinator({ safety: getMutationSafetySnapshot, subscribe: subscribeMutationSafety,
    readBuild: async () => (await fetch('/build.json')).json(), reload, navigationSettled: () => true,
    storage: () => ({ getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value) } }), storageKey: 'attempts',
    defer: callback => { tasks.add(callback); return () => { tasks.delete(callback) } },
  })
  dispose.push(coordinator.mount())
  vi.spyOn(buildReload, 'observe').mockImplementation(coordinator.observe)
  vi.spyOn(buildReload, 'refresh').mockImplementation(coordinator.refresh)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } })
  dispose.push(() => client.clear())
  const flush = () => { const batch = [...tasks]; tasks.clear(); batch.forEach(fn => fn()) }
  return { coordinator, client, reload, flush }
}
function Draft() { const form = useMutationForm({ defaultValues: { name: 'Ada' } }); return <input aria-label="Draft" {...form.register('name')} /> }
function Poll() { const build = useBuild(); return <output>{build.data?.sha}</output> }
it('poll, focus, capabilities and bootstrap route repeated SHA through one coordinator without losing the custom draft', async () => {
  const { coordinator, client, reload, flush } = setup()
  let sha = 'A', revision = 1
  const fetcher = vi.fn(async (path: string) => {
    if (path === '/build.json') return Response.json({ sha, revision, builtAt: '2026-11-17T00:00:00Z' })
    if (path === '/me') return Response.json({ user: null, memberships: [] })
    if (path.endsWith('/capabilities')) return Response.json({ revision, entities: {} })
    throw new Error(`Unexpected read ${path}`)
  }); vi.stubGlobal('fetch', fetcher)
  render(<QueryClientProvider client={client}><Poll /><MutationSession close={() => {}} cancelLabel="Cancel">{() => <Draft />}</MutationSession></QueryClientProvider>)
  await screen.findByText('A'); flush(); expect(reload).toHaveBeenCalledTimes(0)
  fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'Grace' } }); sha = 'B'
  // The interval's query function and a real focus notification both observe B.
  await act(async () => { await client.refetchQueries({ queryKey: ['build'] }) })
  focusManager.setFocused(false); await act(async () => focusManager.setFocused(true)); await waitFor(() => expect(fetcher.mock.calls.filter(([path]) => path === '/build.json').length).toBeGreaterThanOrEqual(3))
  client.setQueryData(['capabilities', 'org'], { revision: 1, entities: {} }); revision = 2
  await act(async () => { await fetchCapabilities(client, 'org'); await coordinator.refresh() })
  client.setQueryData(['instance'], { instance: 'test', roles: [] })
  await act(async () => { await bootstrapOptions(client).queryFn() })
  flush(); expect(reload).toHaveBeenCalledTimes(0); expect(screen.getByLabelText('Draft')).toHaveProperty('value', 'Grace')
  fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'Ada' } }); flush(); expect(reload).toHaveBeenCalledTimes(1)
  await act(async () => { await client.refetchQueries({ queryKey: ['build'] }); await fetchCapabilities(client, 'org'); await coordinator.refresh(); await bootstrapOptions(client).queryFn() }); flush()
  expect(reload).toHaveBeenCalledTimes(1)
})
it('same SHA with a changed capabilities revision observes fresh build metadata without a hard reload', async () => {
  const { coordinator, client, reload, flush } = setup(); coordinator.observe({ sha: 'A' })
  const fetcher = vi.fn(async (path: string) => Response.json(path === '/build.json' ? { sha: 'A', revision: 2, builtAt: 'later' } : { revision: 2, entities: {} }))
  vi.stubGlobal('fetch', fetcher); client.setQueryData(['capabilities', 'org'], { revision: 1, entities: {} })
  await fetchCapabilities(client, 'org'); await coordinator.refresh(); flush()
  expect(fetcher.mock.calls.some(([path]) => path === '/build.json')).toBe(true); expect(reload).toHaveBeenCalledTimes(0)
})
it('the 30-second build poll observes a changed SHA even when revision is unchanged', async () => {
  vi.useFakeTimers()
  const { client, coordinator, reload, flush } = setup()
  let sha = 'A'
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ sha, revision: 1, builtAt: '2026-11-17T00:00:00Z' })))
  try {
    render(<QueryClientProvider client={client}><Poll /></QueryClientProvider>)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) }); flush(); expect(reload).toHaveBeenCalledTimes(0)
    sha = 'B'
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) }); flush(); expect(reload).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) }); flush(); expect(reload).toHaveBeenCalledTimes(1)
    await coordinator.refresh(); flush(); expect(reload).toHaveBeenCalledTimes(1)
  } finally { client.clear(); vi.useRealTimers() }
})
