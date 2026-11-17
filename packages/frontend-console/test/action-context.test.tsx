import type { ReactNode } from 'react'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import { discardAuthority, type ActionContext, useAuthorityAction } from '../src/api/authority'
import { useActionMutation } from '../src/api/action-mutation'

it.each(['success', 'error'] as const)('retirement inside an asynchronous %s handler stops cache, navigation and close effects', async completion => {
  const client = new QueryClient()
  let release = () => {}, entered = () => {}
  const waiting = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  let signal: AbortSignal | undefined
  const effect = vi.fn()
  const handler = async (ctx: ActionContext) => {
    signal = ctx.signal; entered()
    await ctx.run(() => waiting)
    ctx.run(() => client.setQueryData(['private', 'A'], 'obsolete'))
    ctx.run(effect)
  }
  const { result, unmount } = renderHook(() => useActionMutation('A', {
    mutationFn: async ctx => ctx.run(() => { if (completion === 'error') throw new Error('write refused') }),
    ...(completion === 'success' ? { onSuccess: handler } : { onError: handler }),
  }), { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> })
  const pending = result.current.mutateAsync().catch(error => error)
  await started
  discardAuthority(client, 'A'); expect(signal?.aborted).toBe(true)
  release()
  expect(await pending).toMatchObject({ name: 'AbortError' })
  expect(effect).not.toHaveBeenCalled()
  expect(client.getQueryData(['private', 'A'])).toBeUndefined()
  unmount(); client.clear()
})
it.each([undefined, 'A'] as const)('the %s action context rejects later effects and captured contexts after retirement', async org => {
  const client = new QueryClient()
  let captured: ActionContext | undefined
  const { result, unmount } = renderHook(() => useAuthorityAction(org), {
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  })
  await result.current(async ctx => { captured = ctx })
  discardAuthority(client, 'A')
  const send = vi.fn()
  expect(() => captured!.run(send)).toThrow(expect.objectContaining({ name: 'AbortError' }))
  expect(send).not.toHaveBeenCalled()
  unmount(); client.clear()
})
