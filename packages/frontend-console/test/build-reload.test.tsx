import { createBrowserHistory, createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider, Outlet, useBlocker } from '@tanstack/react-router'
import { blockMutationNavigation } from '@workbasehq/ui'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ActionDialog, MutationSession, getMutationSafetySnapshot, subscribeMutationSafety, useMutationForm, useMutationSubmit } from '@workbasehq/ui'
import { createBuildReloadCoordinator } from '../src/build-reload'

const disposals: (() => void)[] = []
afterEach(() => { disposals.splice(0).forEach(dispose => dispose()); vi.restoreAllMocks() })
const deferred = () => { let resolve!: () => void; let reject!: () => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = () => no(new Error('failed')) }); return { promise, resolve, reject } }
function coordinator(realSessions = false, storage = new Map<string, string>(), navigationCheck?: () => boolean) {
  let safety = { dirty: false, submitting: false }, settled = true
  const listeners = new Set<() => void>(), tasks = new Set<() => void>()
  const reload = vi.fn(), readBuild = vi.fn(async (): Promise<{ sha?: string } | undefined> => ({ sha: 'B' }))
  const storageAccess = vi.fn(() => ({ getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) } }))
  const api = createBuildReloadCoordinator({
    safety: realSessions ? getMutationSafetySnapshot : () => safety,
    subscribe: realSessions ? subscribeMutationSafety : listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    readBuild, reload, storage: storageAccess, storageKey: 'test:builds', navigationSettled: navigationCheck ?? (() => settled),
    defer: callback => { tasks.add(callback); return () => { tasks.delete(callback) } },
  })
  disposals.push(api.mount())
  return { ...api, reload, readBuild, storage, storageAccess,
    flush: () => { const batch = [...tasks]; tasks.clear(); batch.forEach(task => task()) },
    safety: (next: typeof safety) => { safety = next; listeners.forEach(listener => listener()) },
    navigate: (next: boolean) => { settled = next; api.recheck() },
  }
}
it('first valid SHA establishes baseline; missing, unbuilt and failed reads are not observations', async () => {
  const c = coordinator()
  c.observe(undefined); c.observe({}); c.observe({ sha: 'unbuilt' }); c.observe({ sha: '' }); c.flush()
  c.readBuild.mockRejectedValueOnce(new Error('offline')); await c.refresh(); c.flush()
  c.observe({ sha: 'A' }); c.flush(); expect(c.reload).toHaveBeenCalledTimes(0)
  c.observe({ sha: 'B' }); c.flush(); expect(c.reload).toHaveBeenCalledTimes(1)
})
it('coalesces to the latest SHA outside any cache, including a rollback to baseline', () => {
  const c = coordinator(); c.observe({ sha: 'A' }); c.safety({ dirty: true, submitting: false })
  c.observe({ sha: 'B' }); c.flush(); c.observe({ sha: 'C' }); c.flush(); expect(c.reload).toHaveBeenCalledTimes(0)
  c.safety({ dirty: false, submitting: false }); c.flush()
  expect(c.reload).toHaveBeenCalledTimes(1); expect(JSON.parse(c.storage.get('test:builds')!)).toEqual(['C'])
  c.safety({ dirty: true, submitting: false }); c.observe({ sha: 'D' }); c.observe({ sha: 'A' })
  c.safety({ dirty: false, submitting: false }); c.flush(); expect(c.reload).toHaveBeenCalledTimes(1)
})
it('latches synchronously and records only SHAs before reload, including a restored document', () => {
  const c = coordinator(); c.observe({ sha: 'A' })
  c.reload.mockImplementation(() => { expect(JSON.parse(c.storage.get('test:builds')!)).toEqual(['B']); c.observe({ sha: 'B' }); c.flush() })
  for (let i = 0; i < 4; i++) c.observe({ sha: 'B' })
  c.flush(); expect(c.reload).toHaveBeenCalledTimes(1)
  const restored = coordinator(false, c.storage); restored.observe({ sha: 'A' }); restored.observe({ sha: 'B' }); restored.flush()
  expect(restored.reload).toHaveBeenCalledTimes(0)
  restored.observe({ sha: 'C' }); restored.flush(); expect(restored.reload).toHaveBeenCalledTimes(1)
})
it.each(['unavailable', 'corrupt'])('handles %s storage and still deduplicates in memory', mode => {
  const c = coordinator()
  if (mode === 'unavailable') c.storageAccess.mockImplementation(() => { throw new Error('disabled') })
  else c.storage.set('test:builds', '{bad json')
  c.observe({ sha: 'A' }); c.observe({ sha: 'B' }); c.flush(); c.observe({ sha: 'B' }); c.flush()
  expect(c.reload).toHaveBeenCalledTimes(1)
})
it('final recheck catches newly dirty state and waits for accepted navigation to settle', () => {
  const c = coordinator(); c.observe({ sha: 'A' }); c.observe({ sha: 'B' })
  c.safety({ dirty: true, submitting: false }); c.flush(); expect(c.reload).toHaveBeenCalledTimes(0)
  c.navigate(false); c.safety({ dirty: false, submitting: false }); c.flush(); expect(c.reload).toHaveBeenCalledTimes(0)
  c.navigate(true); c.flush(); expect(c.reload).toHaveBeenCalledTimes(1)
})
it('BFCache refetches metadata, waits while dirty, and reconciles attempts before a clean restore', async () => {
  const c = coordinator(); c.observe({ sha: 'A' }); c.safety({ dirty: true, submitting: false }); c.observe({ sha: 'B' })
  c.pageShow({ persisted: false }); expect(c.readBuild).toHaveBeenCalledTimes(0)
  c.pageShow({ persisted: true }); await c.refresh(); c.flush(); expect(c.readBuild).toHaveBeenCalledTimes(1); expect(c.reload).toHaveBeenCalledTimes(0)
  c.safety({ dirty: false, submitting: false }); c.flush(); expect(c.reload).toHaveBeenCalledTimes(1)
  c.pageShow({ persisted: true }); await c.refresh(); c.flush(); expect(c.reload).toHaveBeenCalledTimes(1)
  const restored = coordinator(false, c.storage); restored.observe({ sha: 'A' }); restored.observe({ sha: 'B' })
  restored.pageShow({ persisted: true }); await restored.refresh(); restored.flush(); expect(restored.reload).toHaveBeenCalledTimes(0)
})
function CustomForm({ name = 'Draft', save = async () => {}, close }: { name?: string; save?: () => Promise<void>; close?: () => void }) {
  const form = useMutationForm({ defaultValues: { value: 'Ada' } }); const submit = useMutationSubmit()
  return <form aria-label={name} onSubmit={form.handleSubmit(() => submit(async () => { await save(); if (close) close(); else form.reset(form.getValues()) }))}>
    <label>{name}<input {...form.register('value', { required: true })} /></label><button type="submit">Save {name}</button>
  </form>
}
function customSession(name: string, save?: () => Promise<void>) {
  return <MutationSession close={() => {}} cancelLabel="Cancel">{() => <CustomForm name={name} save={save} />}</MutationSession>
}
it('custom form retains invalid/failed draft and target, then saves and reloads after settlement', async () => {
  const c = coordinator(true), first = deferred(), second = deferred(), save = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  render(customSession('Draft', save)); c.observe({ sha: 'A' })
  fireEvent.change(screen.getByRole('textbox', { name: 'Draft' }), { target: { value: '' } }); c.observe({ sha: 'B' }); c.flush()
  await act(async () => { fireEvent.submit(screen.getByRole('form')); }); expect(save).toHaveBeenCalledTimes(0); c.flush(); expect(c.reload).toHaveBeenCalledTimes(0)
  fireEvent.change(screen.getByRole('textbox', { name: 'Draft' }), { target: { value: 'Grace' } })
  await act(async () => { fireEvent.submit(screen.getByRole('form')) }); c.flush(); expect(c.reload).toHaveBeenCalledTimes(0)
  await act(async () => first.reject()); c.flush(); expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveProperty('value', 'Grace'); expect(c.reload).toHaveBeenCalledTimes(0)
  await act(async () => { fireEvent.submit(screen.getByRole('form')) }); c.flush(); expect(c.reload).toHaveBeenCalledTimes(0)
  await act(async () => second.resolve()); c.flush(); expect(c.reload).toHaveBeenCalledTimes(1); expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveProperty('value', 'Grace')
})
it('two real sessions block until both are clean, including revert to pristine', async () => {
  const c = coordinator(true); render(<>{customSession('One')}{customSession('Two')}</>); c.observe({ sha: 'A' })
  fireEvent.change(screen.getByRole('textbox', { name: 'One' }), { target: { value: 'Grace' } }); fireEvent.change(screen.getByRole('textbox', { name: 'Two' }), { target: { value: 'Lin' } })
  c.observe({ sha: 'B' }); c.flush()
  await act(async () => { fireEvent.submit(screen.getByRole('form', { name: 'One' })) }); c.flush(); expect(c.reload).toHaveBeenCalledTimes(0)
  expect(screen.getByRole('textbox', { name: 'Two' })).toHaveProperty('value', 'Lin')
  fireEvent.change(screen.getByRole('textbox', { name: 'Two' }), { target: { value: 'Ada' } }); c.flush(); expect(c.reload).toHaveBeenCalledTimes(1)
})
it('complete and forced cleanup cannot release an action before it settles', async () => {
  const c = coordinator(true), action = deferred(), tail = deferred()
  render(<ActionDialog trigger="Edit" title="Edit" description="Draft" cancelLabel="Cancel">{({ close }) => <CustomForm close={close} save={async () => { await action.promise; close(); await tail.promise }} />}</ActionDialog>)
  fireEvent.click(screen.getByRole('button', { name: 'Edit' })); fireEvent.change(screen.getByRole('textbox', { name: 'Draft' }), { target: { value: 'Grace' } }); c.observe({ sha: 'A' }); c.observe({ sha: 'B' })
  await act(async () => { fireEvent.submit(screen.getByRole('form')) }); await act(async () => action.resolve())
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); c.flush()
  expect(getMutationSafetySnapshot()).toEqual({ dirty: false, submitting: true }); expect(c.reload).toHaveBeenCalledTimes(0)
  await act(async () => tail.resolve()); c.flush(); expect(c.reload).toHaveBeenCalledTimes(1)
})

it.each(['link', 'back'] as const)('confirmed/cancelled discard through %s retains the draft or reloads at the committed destination', async method => {
  const destination = deferred()
  const Root = () => { useBlocker({ shouldBlockFn: blockMutationNavigation }); return <Outlet /> }
  const root = createRootRoute({ component: Root })
  const edit = createRoute({ getParentRoute: () => root, path: '/edit', component: () => <ActionDialog open title="Edit" description="Draft" cancelLabel="Cancel">{() => <CustomForm />}</ActionDialog> })
  const done = createRoute({ getParentRoute: () => root, path: '/done', loader: () => destination.promise, component: () => <h1>Destination</h1> })
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  window.history.replaceState(null, '', '/done')
  const history = method === 'back' ? createBrowserHistory() : createMemoryHistory({ initialEntries: ['/done', '/edit'] })
  if (method === 'back') { history.push('/edit'); history.flush() }
  disposals.push(() => history.destroy())
  const router = createRouter({ routeTree: root.addChildren([edit, done]), history })
  const c = coordinator(true, new Map(), () => router.state.status === 'idle' && !router.state.isLoading)
  const unsubscribe = router.subscribe('onResolved', () => c.recheck()); disposals.push(unsubscribe)
  await router.load(); render(<RouterProvider router={router} />)
  await screen.findByRole('textbox', { name: 'Draft' })
  fireEvent.change(screen.getByRole('textbox', { name: 'Draft' }), { target: { value: 'Grace' } })
  c.observe({ sha: 'A' }); c.observe({ sha: 'B' }); c.flush()
  const navigate = () => { if (method === 'back') router.history.back(); else router.history.push('/done') }
  await act(async () => navigate()); fireEvent.click(await screen.findByRole('button', { name: 'Continue Editing' }))
  expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveProperty('value', 'Grace'); expect(router.state.location.pathname).toBe('/edit'); if (method === 'back') await waitFor(() => expect(window.location.pathname).toBe('/edit')); c.flush(); expect(c.reload).toHaveBeenCalledTimes(0)
  await act(async () => navigate()); fireEvent.click(await screen.findByRole('button', { name: 'Discard' }))
  await waitFor(() => expect(router.state.isLoading).toBe(true)); c.flush(); expect(c.reload).toHaveBeenCalledTimes(0)
  await act(async () => destination.resolve()); await screen.findByRole('heading', { name: 'Destination' }); c.flush()
  expect(c.reload).toHaveBeenCalledTimes(1); expect(router.state.location.pathname).toBe('/done')
})
