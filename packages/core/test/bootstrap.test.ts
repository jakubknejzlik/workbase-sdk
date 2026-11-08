import { beforeEach, expect, it } from 'vitest'
import { setup, roles } from './fixtures/policy-graph/setup'
import { setup as standardSetup, request, json } from '@workbasehq/test-support/helpers'

let app: Awaited<ReturnType<typeof setup>>
beforeEach(async () => { app = await setup() })
async function equivalent(current: typeof app, user: string) {
  const response = await request(current, '/o/org-a/bootstrap', 'GET', undefined, user)
  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  expect(response.headers.get('Vary')).toContain('Authorization')
  const body = await json(response)
  expect(Object.keys(body).sort()).toEqual(['build', 'capabilities', 'console', 'me', 'schema'])
  for (const [key, path] of [['schema', '/schema'], ['capabilities', '/o/org-a/capabilities'], ['console', '/o/org-a/console-registry'], ['me', '/me'], ['build', '/build.json']]) {
    expect(body[key]).toEqual(await json(await request(current, path, 'GET', undefined, user)))
  }
  expect(JSON.stringify(body)).not.toMatch(/SECRET_FILES|CANARY_|predicate|\$actor/)
}
it.each([...roles, 'unknown'])('bootstrap exactly matches the existing actor projections for policyGraph %s', async role => { await equivalent(app, role) })
it.each(['owner-a', 'dispatcher-a', 'viewer-a'])('bootstrap exactly matches standard projections for %s', async user => { await equivalent(await standardSetup(), user) })
it('bootstrap authenticates, binds the path organization, and keeps account bootstrap unscoped', async () => {
  expect((await app.request('http://localhost/bootstrap')).status).toBe(401)
  expect((await app.request('http://localhost/o/org-a/bootstrap')).status).toBe(401)
  expect((await request(app, '/o/org-b/bootstrap', 'GET', undefined, 'reviewer')).status).toBe(403)
  const body = await json(await request(app, '/bootstrap', 'GET', undefined, 'reviewer'))
  expect(body.me).toEqual(await json(await request(app, '/me', 'GET', undefined, 'reviewer')))
  expect(body).not.toHaveProperty('capabilities')
})
it('bootstrap preserves restricted-agent projection and rejects a revoked credential', async () => {
  const { env } = await import('cloudflare:workers')
  const { sha256 } = await import('../src/crypto')
  const token = 'wb_synthetic_bootstrap_restriction'
  await env.DB.prepare('INSERT INTO access_tokens (id,organization_id,token_hash,prefix,role,operations,name,expires_at,issuer_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').bind('boot-agent', 'org-a', await sha256(token), 'wb_synth', 'administrator', JSON.stringify(['records.read']), 'Synthetic agent', new Date(Date.now() + 86400000).toISOString(), 'administrator', 'now').run()
  const headers = { Authorization: `Bearer ${token}` }
  const body = await json(await request(app, '/o/org-a/bootstrap', 'GET', undefined, 'administrator', 'org-a', headers))
  expect(body.me).toEqual(await json(await request(app, '/me', 'GET', undefined, 'administrator', 'org-a', headers)))
  expect(body.capabilities).toEqual(await json(await request(app, '/o/org-a/capabilities', 'GET', undefined, 'administrator', 'org-a', headers)))
  expect(body.capabilities.entities.records.operations).toEqual(['read'])
  expect(body.capabilities.entities.teams.operations).toEqual([])
  await env.DB.prepare("UPDATE access_tokens SET revoked_at='now' WHERE id='boot-agent'").run()
  expect((await request(app, '/o/org-a/bootstrap', 'GET', undefined, 'administrator', 'org-a', headers)).status).toBe(401)
})
