import { env } from 'cloudflare:workers'
import { beforeEach, expect, it, vi } from 'vitest'
import { setup, runtime, request, json, insertDomain } from '@workbasehq/test-support/helpers'
import { cursorSecret } from '../src/query/routes'
import { encodeCursor } from '../src/query/cursor'
import { signWebhook } from '../src/crypto'

beforeEach(async () => { await setup() })
it.each(['identity', 'flat', 'internal'] as const)('cursor MAC uses a dedicated subkey for the %s secret', async source => {
  const raw = 'synthetic-cursor-configured-secret'
  const bindings = { DB: env.DB, AUDIT_KV: env.AUDIT_KV, ...(source === 'identity' ? { IDENTITY: { baseURL: 'http://localhost', secret: raw } } : source === 'flat' ? { BETTER_AUTH_SECRET: raw } : { INTERNAL_TOKEN: raw }) }
  const dedicated = await cursorSecret(bindings)
  const cursor = await encodeCursor(dedicated, 'hash', 1, ['id'])
  const [payload, mac] = cursor.split('.')
  expect(mac).not.toBe(await signWebhook(raw, `workbase-query-cursor-v1.${payload}`))
  expect(await cursorSecret(bindings)).toBe(dedicated)
  expect(await cursorSecret({ ...bindings })).toBe(dedicated)
})
it('query rejects a cursor signed with the raw identity secret and accepts its own continuation', async () => {
  const app = await setup()
  await insertDomain()
  expect((await request(app, '/api/clients', 'POST', { name: 'Second client' })).status).toBe(201)
  const input = { entity: 'clients', select: ['id'], limit: 1 }
  const first = await json(await request(app, '/query', 'POST', input))
  expect(first.next_cursor).toBeTruthy()
  const payload = first.next_cursor.split('.')[0]
  const forged = `${payload}.${await signWebhook(runtime().IDENTITY.secret, `workbase-query-cursor-v1.${payload}`)}`
  const rejected = await request(app, '/query', 'POST', { ...input, cursor: forged })
  expect(rejected.status).toBe(400)
  expect(await json(rejected)).toEqual({ error: 'query_invalid', path: ['cursor'] })
  const continued = await request(app, '/query', 'POST', { ...input, cursor: first.next_cursor })
  expect(continued.status).toBe(200)
  expect((await json(continued)).data[0].id).not.toBe(first.data[0].id)
})

it('cursor key retries a rejected derivation and caches the successful retry', async () => {
  const bindings = runtime()
  const failure = new Error('transient HKDF failure')
  const derive = vi.spyOn(crypto.subtle, 'deriveBits').mockRejectedValueOnce(failure)
  try {
    const first = cursorSecret(bindings)
    expect(cursorSecret(bindings)).toBe(first)
    await expect(first).rejects.toBe(failure)
    const retry = cursorSecret(bindings)
    expect(retry).not.toBe(first)
    const key = await retry
    expect(key).toMatch(/^[a-f0-9]{64}$/)
    expect(await cursorSecret(bindings)).toBe(key)
    expect(derive).toHaveBeenCalledTimes(2)
  } finally { derive.mockRestore() }
})
