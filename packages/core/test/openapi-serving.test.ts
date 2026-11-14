import { expect, it, vi } from 'vitest'
import { createApp } from '../src/app'
import { bindOpenApi } from '../src/schema'
import { publicConsoleResponse } from '../src/console'
import { workerFetch } from '../src/worker-fetch'
import { runtime } from '@workbasehq/test-support/helpers'
import config from './fixtures/worker-access/config'
import spec from './fixtures/worker-access/openapi.json'

const bytes = JSON.stringify(spec, null, 2) + '\n'
it('serves the committed public artifact anonymously and unchanged across identities and copies', async () => {
  const assets = vi.fn(async () => new Response('asset'))
  for (const value of [config, structuredClone(config), JSON.parse(JSON.stringify(config)), bindOpenApi({ ...config }, Object.fromEntries(Object.entries(spec).reverse()))]) {
    const app = createApp(value, { ...runtime(), ASSETS: { fetch: assets } as unknown as Fetcher })
    for (const headers of [{}, { Authorization: 'Bearer synthetic-access-secret-at-least-32' }, { Cookie: 'session=synthetic-access-secret-at-least-32' }] as Record<string, string>[]) {
      const response = await app.request('/openapi.json', { headers })
      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toContain('application/json')
      expect(await response.text()).toBe(bytes)
    }
  }
  expect(assets).not.toHaveBeenCalled()
})

it('leaves the spec for the loaded app and reserves its namespace from ASSETS and the SPA', async () => {
  const assets = vi.fn(async () => new Response('asset'))
  const env = { ...runtime(), ASSETS: { fetch: assets } as unknown as Fetcher }
  const app = createApp(config, env), load = vi.fn(async () => app)
  const fetch = workerFetch(load)
  for (const method of ['GET', 'HEAD']) {
    const request = new Request('http://localhost/openapi.json', { method })
    expect(await publicConsoleResponse(request, env)).toBeUndefined()
    const response = await fetch(request, env)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(method === 'HEAD' ? '' : bytes)
  }
  for (const path of ['/openapi.json/unknown', '/openapi.json']) {
    const response = await app.request(path, { method: path.endsWith('unknown') ? 'GET' : 'POST' })
    expect(response.status).toBe(404)
  }
  expect(load).toHaveBeenCalledTimes(2)
  expect(assets).not.toHaveBeenCalled()
})

it('fails closed for an unbound or invalid serialized SDK config', async () => {
  for (const openapi of [undefined, {}, { ...spec, 'x-workbase-revision': 2 }]) {
    const response = await createApp({ ...config, openapi } as typeof config, runtime()).request('/openapi.json')
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'openapi_not_bound' })
  }
  for (const value of [null, {}, { ...spec, info: { version: 'r2' } }]) expect(() => bindOpenApi({ ...config }, value)).toThrow('Invalid openapi.json binding')
})

it('adds the disk hash to both build metadata paths, preserving existing keys and no-store', async () => {
  const env = { ...runtime(), BUILD_SHA: '0'.repeat(40), BUILD_AT: '2026-11-14T00:00:00.000Z', OPENAPI_SHA256: '0'.repeat(64), SCHEMA_EXPECTED: JSON.stringify({ revision: config.revision }) }
  for (const method of ['GET', 'HEAD']) {
    const request = new Request('http://localhost/build.json', { method })
    const early = await publicConsoleResponse(request, env)
    const loaded = await createApp(config, env).request(request)
    expect(early!.headers.get('Cache-Control')).toBe('no-store')
    expect(loaded.headers.get('Cache-Control')).toBe('no-store')
    const text = await loaded.text()
    expect(await early!.text()).toBe(text)
    if (method === 'GET') expect(JSON.parse(text)).toEqual({ sha: env.BUILD_SHA, builtAt: env.BUILD_AT, revision: config.revision, openapi: env.OPENAPI_SHA256 })
  }
})

it('rejects an authored openapi on legacy defineInstance/normalizeInstance (PR #33 verify1)', async () => {
  const { defineInstance, normalizeInstance } = await import('../src/config')
  const input = { id: 'legacy', revision: 1, roles: ['admin'], organizationOwnerRole: 'admin', entities: {}, permissions: {}, openapi: { ...spec } }
  for (const normalize of [defineInstance, normalizeInstance]) expect(() => normalize(input as never)).toThrow(/legacy configs cannot carry it/)
})
