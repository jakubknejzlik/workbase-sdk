import type { ReactNode } from 'react'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { discardAuthority } from '../src/api/authority'
import { useIdentityAction } from '../src/api/identity'
import { useWorkflowAction } from '../src/api/workflows'
import { tokenClient, useTokenAction } from '../src/api/tokens'
afterEach(() => vi.unstubAllGlobals())
const caps = { revision: 1, organization: { role: 'admin' }, entities: {}, commands: [], workflows: { probe: ['start'] }, resources: { 'members.update': true, 'tokens.create': true } }
for (const kind of ['identity', 'workflow'] as const) it.each(['organization', 'capabilities'] as const)(`${kind} stops after a retired %s preflight`, async preflight => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['capabilities', 'A'], caps)
  let release: (value: unknown) => void = () => {}
  const waiting = new Promise<never>(resolve => { release = value => resolve(value as never) })
  // A preflight adapter may finish despite cancellation; exercise the action's
  // generation check independently of transport/query cancellation.
  const reads = vi.spyOn(client, 'fetchQuery')
  reads.mockReturnValueOnce(preflight === 'organization' ? waiting : Promise.resolve({ role: 'admin' } as never))
  if (preflight === 'capabilities') reads.mockReturnValueOnce(waiting)
  const fetch = vi.fn(async () => Response.json({ token: 'synthetic' }))
  vi.stubGlobal('fetch', fetch)
  const { result, unmount } = renderHook(() => ({ identity: useIdentityAction('A'), workflow: useWorkflowAction('A', 'probe', 'start') }), {
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  })
  const send = vi.fn(async () => { await tokenClient.create('A', { name: 'OLD DRAFT', role: 'viewer' }) })
  const pending = (kind === 'identity' ? result.current.identity(send, 'members.update') : result.current.workflow(send)).catch(error => error)
  await Promise.resolve()
  discardAuthority(client, 'A')
  release(preflight === 'organization' ? { role: 'admin' } : caps)
  expect(await pending).toMatchObject({ name: 'AbortError' })
  expect(send).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
  unmount(); client.clear()
})
it('unchanged authority allows a token action and its one-time result', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['capabilities', 'A'], caps)
  const fetch = vi.fn(async (path: string) => Response.json(path.endsWith('/capabilities') ? caps : { token: 'synthetic' }))
  vi.stubGlobal('fetch', fetch)
  const { result, unmount } = renderHook(() => useTokenAction('A'), {
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  })
  const receive = vi.fn()
  await result.current('tokens.create', async assertCurrent => {
    const response = await tokenClient.create('A', { name: 'Fresh draft', role: 'viewer' })
    assertCurrent(); receive(response.token)
  })
  expect(receive).toHaveBeenCalledWith('synthetic')
  expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/o/A/capabilities', '/orgs/A/tokens'])
  unmount(); client.clear()
})
