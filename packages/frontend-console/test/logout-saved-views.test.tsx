import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const ownKey = 'workbase:saved-views:v1:instance:user:org:entries'
const otherKey = 'workbase:saved-views:v1:instance:other:org:entries'
let store: Storage, assign: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.resetModules()
  const data = new Map<string, string>([[ownKey, '{}'], [otherKey, '{}'], ['console-language', 'cs']])
  store = { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) }, clear: vi.fn(), key: index => [...data.keys()][index] ?? null, get length() { return data.size } }
  vi.stubGlobal('localStorage', store)
  assign = vi.fn(() => { expect(store.getItem(ownKey)).toBeNull() })
  const realWindow = window
  vi.stubGlobal('window', new Proxy(realWindow, { get: (target, key) => key === 'location' ? { origin: 'https://console.test', pathname: '/o/org/e/entries', search: '', assign } : Reflect.get(target, key) }))
})
afterEach(() => vi.unstubAllGlobals())
it.each([204, 401])('explicit logout %s cleans verified account namespaces before navigation', async status => {
  const { logoutSession } = await import('../src/api/client')
  vi.stubGlobal('fetch', vi.fn(async () => status === 204 ? new Response(null, { status }) : Response.json({ error: 'expired' }, { status })))
  const client = new QueryClient(); client.setQueryData(['me'], { user: { id: 'user' } }); client.setQueryData(['instance'], { instance: 'instance' })
  await logoutSession(client)
  expect(assign).toHaveBeenCalledWith('/sign-in')
  expect(store.getItem(otherKey)).toBe('{}')
  expect(store.getItem('console-language')).toBe('cs')
  expect(store.clear).not.toHaveBeenCalled()
  expect(client.getQueryCache().getAll()).toHaveLength(0)
})
it('unknown verified scope falls back to feature-prefixed keys only', async () => {
  const { logoutSession } = await import('../src/api/client')
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
  await logoutSession(new QueryClient())
  expect(store.getItem(otherKey)).toBeNull(); expect(store.getItem('console-language')).toBe('cs'); expect(store.clear).not.toHaveBeenCalled()
})
it.each([204, 401])('storage failure cannot prevent explicit logout %s', async status => {
  const { logoutSession } = await import('../src/api/client')
  vi.stubGlobal('fetch', vi.fn(async () => status === 204 ? new Response(null, { status }) : Response.json({}, { status })))
  Object.defineProperty(store, 'length', { get() { throw new Error('denied') } })
  assign.mockImplementation(() => {})
  await logoutSession(new QueryClient())
  expect(assign).toHaveBeenCalledWith('/sign-in')
})
it('ordinary 401 redirects without removing saved views', async () => {
  const { api } = await import('../src/api/client')
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'expired' }, { status: 401 })))
  assign.mockImplementation(() => {})
  await expect(api('/me')).rejects.toMatchObject({ status: 401 })
  expect(assign).toHaveBeenCalledTimes(1)
  expect(store.getItem(ownKey)).toBe('{}'); expect(store.getItem(otherKey)).toBe('{}')
})
