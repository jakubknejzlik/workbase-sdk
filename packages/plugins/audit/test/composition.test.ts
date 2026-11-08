import { auditEvents } from '../../../core/test/audit-helpers'
import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import sample from '../../../core/test/fixtures/sample/config'
import { createApp } from '../../../core/src/app'
import { KernelRegistry } from '../../../core/src/kernel/registry'
import { applyPluginMigrations } from '../../../core/src/kernel/migrations'
import { initialSchema } from '../../../core/src/migrations/schema'
import { audit as pluginaudit } from '@workbasehq/plugins/audit'
import { relay } from '../../../core/src/relay'
import { insertDomain, request, runtime, setup } from '@workbasehq/test-support/helpers'

beforeEach(async () => { await setup(); await insertDomain() })
it('installs durable audit storage and consumption as an explicit provider', async () => {
  expect(pluginaudit().provides).toEqual({ audit: '1.x' })
  const app = createApp(sample, runtime())
  expect((await request(app, '/api/clients', 'POST', { name: 'Audited' })).status).toBe(201)
  const kernel = new KernelRegistry(sample)
  expect((await kernel.audit!.relay(runtime())).delivered).toBe(1)
  const payload = JSON.stringify((await auditEvents())[0])
  expect(JSON.parse(payload!)).toMatchObject({ actor: { id: 'owner-a' }, organization_id: 'org-a', operation: 'clients.created' })
  expect(payload).not.toMatch(/synthetic-owner|Bearer|token_hash/)
})
it('uninstall removes routes and consumption while preserving events and queued intents', async () => {
  const app = createApp(sample, runtime())
  await request(app, '/api/clients', 'POST', { name: 'Queued' })
  const without = { ...sample, plugins: sample.plugins!.filter(p => p.name !== 'audit') }
  expect((await request(createApp(without, runtime()), '/audit/events')).status).toBe(404)
  const capabilities = await request(createApp(without, runtime()), '/o/org-a/capabilities')
  expect(await capabilities.json()).toMatchObject({ resources: { 'audit.read': false } })
  expect(new KernelRegistry(without).audit).toBeUndefined()
  await relay(runtime(), without)
  expect((await auditEvents()).length).toBe(0)
  expect(await env.DB.prepare('SELECT count(*) n FROM audit_outbox WHERE delivered_at IS NULL').first('n')).toBe(1)
  await relay(runtime(), sample)
  expect((await auditEvents()).length).toBe(1)
})

it('upgrades an installed audit plugin without losing pending events or reapplying the backoff migration', async () => {
  const plugin = pluginaudit()
  await env.FRESH_DB.exec(initialSchema(sample).replaceAll('\n', ' '))
  await applyPluginMigrations(env.FRESH_DB, [{ ...plugin, migrations: plugin.migrations!.slice(0, 1) }])
  await env.FRESH_DB.prepare('INSERT INTO audit_outbox (event_id,organization_id,payload,created_at) VALUES (?,?,?,?)')
    .bind('pending-upgrade', 'org-a', '{"immutable":"event"}', new Date().toISOString()).run()
  await expect(plugin.checkSchema!(env.FRESH_DB, sample)).rejects.toThrow('no such column: next_attempt_at')
  await applyPluginMigrations(env.FRESH_DB, [plugin])
  await applyPluginMigrations(env.FRESH_DB, [plugin])
  await expect(plugin.checkSchema!(env.FRESH_DB, sample)).resolves.toBeUndefined()
  expect(await env.FRESH_DB.prepare('SELECT event_id,payload,attempts,next_attempt_at,delivered_at FROM audit_outbox').first()).toEqual({
    event_id: 'pending-upgrade', payload: '{"immutable":"event"}', attempts: 0, next_attempt_at: null, delivered_at: null,
  })
  expect(await env.FRESH_DB.prepare("SELECT count(*) n FROM _plugin_migrations WHERE namespace='audit'").first('n')).toBe(2)
})
