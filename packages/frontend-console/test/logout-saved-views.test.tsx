import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const ownKey = 'workbase:saved-views:v1:instance:user:org:entries'
const ownPrefs = 'workbase:list-prefs:v1:instance:user:org:entries'
const ownOtherOrgPrefs = 'workbase:list-prefs:v1:instance:user:second:other'
const otherPrefs = 'workbase:list-prefs:v1:instance:other:org:entries'
const otherInstancePrefs = 'workbase:list-prefs:v1:other:user:org:entries'
const otherKey = 'workbase:saved-views:v1:instance:other:org:entries'
let store: Storage, assign: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.resetModules()
  const data = new Map<string, string>([[ownPrefs, '{}'], [ownOtherOrgPrefs, '{}'], [otherPrefs, '{}'], [otherInstancePrefs, '{}'], [ownKey, '{}'], [otherKey, '{}'], ['console-language', 'cs']])
  store = { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) }, clear: vi.fn(), key: index => [...data.keys()][index] ?? null, get length() { return data.size } }
  vi.stubGlobal('localStorage', store)
  assign = vi.fn()
  const realWindow = window
  vi.stubGlobal('window', new Proxy(realWindow, { get: (target, key) => key === 'location' ? { origin: 'https://console.test', pathname: '/o/org/e/entries', search: '', assign } : Reflect.get(target, key) }))
})
afterEach(() => vi.unstubAllGlobals())
it.each([204, 401])('explicit logout %s cleans verified account namespaces before navigation', async status => {
  const { logoutSession } = await import('../src/api/client')
  vi.stubGlobal('fetch', vi.fn(async () => status === 204 ? new Response(null, { status }) : Response.json({ error: 'expired' }, { status })))
  const client = new QueryClient(); client.setQueryData(['me'], { user: { id: 'user' } }); client.setQueryData(['instance'], { instance: 'instance' })
  client.setQueryData(['organization', 'org'], { user: { id: 'user' }, memberships: [{ organization_id: 'org' }] })
  client.setQueryData(['console-model', 'org'], { model: { instance: 'instance' } })
  assign.mockImplementation(() => { expect(store.getItem(ownKey)).toBeNull(); expect(store.getItem(ownPrefs)).toBeNull(); expect(store.getItem(ownOtherOrgPrefs)).toBeNull() })
  await logoutSession(client, 'org')
  expect(assign).toHaveBeenCalledWith('/sign-in')
  expect(store.getItem(otherPrefs)).toBe('{}'); expect(store.getItem(otherInstancePrefs)).toBe('{}')
  expect(store.getItem(otherKey)).toBe('{}')
  expect(store.getItem('console-language')).toBe('cs')
  expect(store.clear).not.toHaveBeenCalled()
  expect(client.getQueryCache().getAll()).toHaveLength(0)
})
it.each(['none', 'user-only', 'instance-only', 'missing-model', 'missing-user', 'unverified-membership', 'failed-identity', 'failed-model'])('unknown verified scope (%s) preserves every account and instance', async known => {
  const { logoutSession } = await import('../src/api/client')
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
  const client = new QueryClient()
  if (known === 'user-only') client.setQueryData(['me'], { user: { id: 'user' } })
  if (known === 'instance-only') client.setQueryData(['instance'], { instance: 'instance' })
  if (['missing-model', 'unverified-membership', 'failed-identity', 'failed-model'].includes(known)) client.setQueryData(['organization', 'org'], { user: { id: 'user' }, memberships: known === 'unverified-membership' ? [] : [{ organization_id: 'org' }] })
  if (['missing-user', 'unverified-membership', 'failed-identity', 'failed-model'].includes(known)) client.setQueryData(['console-model', 'org'], { model: { instance: 'instance' } })
  if (known === 'failed-identity' || known === 'failed-model') client.getQueryCache().find({ queryKey: [known === 'failed-identity' ? 'organization' : 'console-model', 'org'] })!.setState({ status: 'error', error: new Error('unavailable') })
  await logoutSession(client, 'org')
  for (const key of [ownKey, ownPrefs, ownOtherOrgPrefs, otherPrefs, otherInstancePrefs, otherKey]) expect(store.getItem(key)).toBe('{}')
  expect(assign).toHaveBeenCalledWith('/sign-in')
  expect(store.getItem('console-language')).toBe('cs'); expect(store.clear).not.toHaveBeenCalled()
})
it.each([204, 401])('storage failure cannot prevent explicit logout %s', async status => {
  const { logoutSession } = await import('../src/api/client')
  vi.stubGlobal('fetch', vi.fn(async () => status === 204 ? new Response(null, { status }) : Response.json({}, { status })))
  Object.defineProperty(store, 'length', { get() { throw new Error('denied') } })
  assign.mockImplementation(() => {})
  const client = new QueryClient()
  client.setQueryData(['organization', 'org'], { user: { id: 'user' }, memberships: [{ organization_id: 'org' }] })
  client.setQueryData(['console-model', 'org'], { model: { instance: 'instance' } })
  await logoutSession(client, 'org')
  expect(assign).toHaveBeenCalledWith('/sign-in')
})
it('ordinary 401 redirects without removing saved views', async () => {
  const { api } = await import('../src/api/client')
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'expired' }, { status: 401 })))
  assign.mockImplementation(() => {})
  await expect(api('/me')).rejects.toMatchObject({ status: 401 })
  expect(assign).toHaveBeenCalledTimes(1)
  expect(store.getItem(ownPrefs)).toBe('{}'); expect(store.getItem(otherPrefs)).toBe('{}')
  expect(store.getItem(ownKey)).toBe('{}'); expect(store.getItem(otherKey)).toBe('{}')
})
