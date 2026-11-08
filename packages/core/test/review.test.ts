import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { setup, insertDomain, request, json, runtime } from '@workbasehq/test-support/helpers'
import { defineInstance } from '../src/config'
import { plan } from '../src/migrations/planner'
import { sha256 } from '../src/crypto'
import { createApp } from '../src/app'
import { counterCommands } from './fixtures/sample/commands'
import sample from './fixtures/sample/config'
import service from './fixtures/sample/secondary'
beforeEach(async () => { await setup() })
it('A1 drops populated child tables before their parents', async () => {
  const app = await setup(service)
  const client = await json(await request(app, '/api/clients', 'POST', { name: 'Client' }))
  const sr = await json(await request(app, '/api/tasks', 'POST', { title: 'Request', client_id: client.id }))
  await request(app, '/api/notes', 'POST', { request_id: sr.id, body: 'Note' })
  const target = defineInstance({ ...service, revision: 2, ui: undefined, policies: { clients: service.policies.clients }, entities: { clients: { ...service.entities.clients, relations: {} } }, permissions: { owner: { clients: ['read'] } } })
  const migration = plan(service, target, { allowDestructive: true })
  expect(migration.blocked).toEqual([])
  expect(migration.sql.indexOf('DROP TABLE "notes"')).toBeLessThan(migration.sql.indexOf('DROP TABLE "tasks"'))
  await env.DB.exec(migration.sql.split('\n').filter(l => !l.startsWith('--')).join(' '))
  expect(await env.DB.prepare('SELECT count(*) AS n FROM clients').first('n')).toBe(1)
})
it('A2 coalesces nullable reference backfills to the required default', async () => {
  await setup(); const app = createApp(sample, runtime(), { commands: counterCommands }); await insertDomain()
  await request(app, '/commands/bookings/create', 'POST', { slotId: 'slot-org-a', clientId: 'client-org-a', idempotencyKey: 'nullable' })
  const target = defineInstance({ ...sample, revision: sample.revision + 1, entities: { ...sample.entities, bookings: { ...sample.entities.bookings, fields: { ...sample.entities.bookings.fields, contact_snapshot: { type: 'string', required: true, readOnly: true, default: '', backfillFrom: { refField: 'client_id', valueField: 'email' } } } } } })
  const migration = plan(sample, target)
  expect(migration.blocked).toEqual([])
  await env.DB.exec(migration.sql.split('\n').filter(l => !l.startsWith('--')).join(' '))
  expect(await env.DB.prepare('SELECT contact_snapshot FROM bookings').first('contact_snapshot')).toBe('')
})
it('A4 hashes unknown organization selectors instead of retaining raw personal data', async () => {
  const app = await setup()
  expect((await request(app, '/api/clients', 'GET', undefined, 'owner-a', 'private@example.test')).status).toBe(403)
  const row = await env.DB.prepare('SELECT * FROM security_log').first<any>()
  expect(row.organization_id).toBeNull()
  expect(row.requested_scope_hash).toBe(await sha256('private@example.test'))
  expect(JSON.stringify(row)).not.toContain('private@example.test')
  await request(app, '/api/clients', 'POST', { name: 'Denied' }, 'viewer-a')
  const known = await env.DB.prepare('SELECT organization_id,requested_scope_hash FROM security_log WHERE organization_id=?').bind('org-a').first<any>()
  expect(known).toEqual({ organization_id: 'org-a', requested_scope_hash: null })
})
