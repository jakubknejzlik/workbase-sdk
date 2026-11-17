import { expect, it } from 'vitest'
import { machineCredentials } from '@workbasehq/plugins/machine-credentials'
import { members } from '@workbasehq/plugins/members'
import { organizations } from '@workbasehq/plugins/organizations'
import { actionFixture, closeRecord } from './record-actions'
import { ApiError } from '../../src/errors'
import type { App } from '../../src/types'
import type { WorkbasePlugin } from '../../src/kernel/plugin'

type Setup = (config: ReturnType<typeof actionFixture>) => Promise<{ app: App; db: D1Database }>
const ids = ['open', 'closed', 'nonexistent', 'foreign', 'filtered']
function request(path: string, post = false, body: object = {}, token = 'synthetic-staff') {
  return new Request(`http://localhost${path}`, { method: post ? 'POST' : 'GET', headers: {
    Authorization: `Bearer ${token}`, 'X-Organization-Id': 'org-a', 'Content-Type': 'application/json',
  }, ...(post ? { body: JSON.stringify(body) } : {}) })
}
const snapshot = async (db: D1Database) => ({
  rows: (await db.prepare('SELECT id,state,version FROM record ORDER BY id').all()).results,
  audits: await db.prepare('SELECT count(*) AS n FROM audit_outbox').first('n'),
})
function withPlugin(plugin: WorkbasePlugin, commands = [closeRecord]) {
  const config = actionFixture(undefined, commands)
  config.plugins = [...config.plugins!, plugin]
  return config
}
const idMask: WorkbasePlugin = { name: 'id-mask', version: '1.0.0', fieldMask(entity, scope) {
  return entity === 'record' && scope.role === 'staff' ? ['state', 'version']
    : ['id', 'organization_id', 'created_at', 'updated_at', 'version', ...Object.keys(this.config.entities[entity].fields)]
} }
const rejectClosed = { ...closeRecord, prepare: async (ctx: Parameters<NonNullable<typeof closeRecord.prepare>>[0], { id }: { id: string }) => {
  const row = await ctx.reader.first<{ state: string }>({ sql: 'SELECT state FROM record WHERE id=?', bindings: [id] })
  if (row?.state === 'closed') throw new ApiError(409, 'record_already_closed')
  return undefined
} }

/** Identical adversarial requests run against native D1 and the SQLite adapter. */
export function recordActionSecurityTests(setup: Setup) {
  it.each(['primary', 'additional'] as const)('security hooks: %s entity grant denial omits availability and matches generic dispatch', async grant => {
    let callbacks = 0
    const command = { ...closeRecord, ...(grant === 'additional' ? { additionalPermissions: [{ entity: 'worker', operation: 'update' as const }] } : {}), prepare: async () => { callbacks++; return undefined } }
    const config = withPlugin({ name: 'entity-denial', version: '1.0.0', commandGuard(command) {
      return command.kind === 'entity' && 'entity' in command.permission && command.permission.entity === (grant === 'primary' ? 'record' : 'worker') && command.permission.operation === 'update'
        ? { allow: false, code: 'entity_update_denied' } : { allow: true }
    } }, [command])
    const { app, db } = await setup(config)
    const before = await snapshot(db)
    const detail = await app.fetch(request('/api/record/open'))
    expect(detail.status).toBe(200)
    expect((await detail.json() as any).actions).not.toHaveProperty('close')
    const generic = await app.fetch(request('/commands/record/close', true, { id: 'open' }))
    const action = await app.fetch(request('/api/record/open/actions/close', true))
    expect(generic.status).toBe(403)
    expect(action.status).toBe(generic.status)
    expect(await action.text()).toBe(await generic.text())
    expect(await snapshot(db)).toEqual(before)
    expect(callbacks).toBe(0)
  })

  it('security prepare: hidden records run neither prepare nor plan and return GET bytes', async () => {
    let prepares = 0, plans = 0
    const command = { ...rejectClosed, prepare: async (...args: Parameters<typeof rejectClosed.prepare>) => { prepares++; return rejectClosed.prepare(...args) },
      plan: (...args: Parameters<typeof closeRecord.plan>) => { plans++; return closeRecord.plan(...args) } }
    const { app, db } = await setup(actionFixture(undefined, [command]))
    await db.exec("UPDATE record SET state='closed' WHERE id IN ('foreign','filtered')")
    const before = await snapshot(db)
    for (const id of ['nonexistent', 'foreign', 'filtered']) {
      const get = await app.fetch(request(`/api/record/${id}`))
      const post = await app.fetch(request(`/api/record/${id}/actions/close`, true))
      expect(get.status).toBe(404)
      expect(post.status).toBe(get.status)
      expect(await post.text()).toBe(await get.text())
    }
    expect(prepares).toBe(0); expect(plans).toBe(0)
    expect(await snapshot(db)).toEqual(before)
  })

  it('security prepare: an inconclusive visibility recheck is an opaque 5xx, not a client error', async () => {
    let db: D1Database
    const command = { ...closeRecord, prepare: async () => {
      // Make the post-error GET-authority read fail as an infrastructure fault would.
      await db.exec('ALTER TABLE record RENAME TO record_unavailable')
      throw new ApiError(503, 'backend_unavailable')
    } }
    const fixture = await setup(actionFixture(undefined, [command])); db = fixture.db
    const post = await fixture.app.fetch(request('/api/record/open/actions/close', true))
    await db.exec('ALTER TABLE record_unavailable RENAME TO record')
    expect([post.status, await post.text()]).toEqual([500, '{"error":"internal_error"}'])
    expect((await fixture.app.fetch(request('/api/record/open'))).status).toBe(200)
    expect(await snapshot(db)).toMatchObject({ audits: 0 })
  })

  it.each(['prepare', 'plan'] as const)('security prepare: visibility is rechecked after a %s error', async phase => {
    let db: D1Database
    const command = { ...closeRecord, prepare: async () => {
      await db.exec("UPDATE record SET user='admin' WHERE id='open'")
      if (phase === 'prepare') throw new ApiError(409, 'record_already_closed')
      return undefined
    }, plan: (...args: Parameters<typeof closeRecord.plan>) => {
      if (phase === 'plan') throw new ApiError(422, 'record_plan_rejected')
      return closeRecord.plan(...args)
    } }
    const fixture = await setup(actionFixture(undefined, [command])); db = fixture.db
    const post = await fixture.app.fetch(request('/api/record/open/actions/close', true))
    const get = await fixture.app.fetch(request('/api/record/open'))
    expect(post.status).toBe(404)
    expect(await post.text()).toBe(await get.text())
    expect(await db.prepare("SELECT state,version FROM record WHERE id='open'").first()).toEqual({ state: 'open', version: 1 })
    expect(await db.prepare('SELECT count(*) AS n FROM audit_outbox').first('n')).toBe(0)
  })

  it.each(['idmask', 'read-hook', 'credential'] as const)('security root readability: %s denial matches GET for every ID and action', async scenario => {
    let callbacks = 0
    const command = { ...closeRecord, prepare: async () => { callbacks++; return undefined } }
    const config = scenario === 'idmask' ? withPlugin(idMask, [command]) : scenario === 'read-hook' ? withPlugin({
      name: 'read-denial', version: '1.0.0', commandGuard(command) {
        return command.kind === 'entity' && 'entity' in command.permission && command.permission.entity === 'record' && command.permission.operation === 'read'
          ? { allow: false, code: 'entity_read_denied' } : { allow: true }
      },
    }, [command]) : actionFixture(undefined, [command])
    if (scenario === 'credential') config.plugins = [...config.plugins!, members, organizations, machineCredentials()]
    const { app, db } = await setup(config)
    let token: string | undefined
    if (scenario === 'credential') {
      token = 'wb_synthetic_command_only'
      const { sha256 } = await import('../../src/crypto')
      await db.prepare('INSERT INTO access_tokens (id,organization_id,issuer_id,prefix,name,token_hash,role,operations,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .bind('command-only', 'org-a', 'staff', 'wb_synthetic', 'command-only', await sha256(token), 'staff', JSON.stringify(['record/close']), new Date(Date.now() + 86400000).toISOString(), 'now').run()
    }
    const before = await snapshot(db)
    for (const id of ids) for (const name of ['close', 'secret', 'unknown']) {
      const get = await app.fetch(request(`/api/record/${id}`, false, {}, token))
      const post = await app.fetch(request(`/api/record/${id}/actions/${name}`, true, {}, token))
      expect(get.status).toBe(403)
      expect(post.status).toBe(get.status)
      expect(await post.text()).toBe(await get.text())
    }
    expect(callbacks).toBe(0)
    expect(await snapshot(db)).toEqual(before)
  })

  it.each([
    ['hooks', 'open'], ['prepare', 'closed'], ['prepare', 'foreign'],
    ['prepare', 'filtered'], ['prepare', 'nonexistent'], ['success', 'open'],
  ])('security differential: %s/%s generic/action status class and write/audit counts agree', async (scenario, id) => {
    const results = []
    for (const route of ['generic', 'action']) {
      const config = scenario === 'hooks' ? withPlugin({ name: 'deny-update', version: '1.0.0', commandGuard(command) {
        return command.kind === 'entity' && 'entity' in command.permission && command.permission.operation === 'update'
          ? { allow: false, code: 'entity_update_denied' } : { allow: true }
      } }, [rejectClosed]) : actionFixture(undefined, [rejectClosed])
      const { app, db } = await setup(config)
      if (scenario === 'prepare') await db.exec("UPDATE record SET state='closed' WHERE id IN ('foreign','filtered')")
      const response = await app.fetch(request(route === 'generic' ? '/commands/record/close' : `/api/record/${id}/actions/close`, true, route === 'generic' ? { id } : {}))
      results.push({ statusClass: Math.floor(response.status / 100),
        writes: await db.prepare('SELECT sum(version-1) AS n FROM record').first('n'),
        audits: await db.prepare('SELECT count(*) AS n FROM audit_outbox').first('n') })
    }
    expect(results[1]).toEqual(results[0])
    expect(results[0]).toEqual(scenario === 'success' ? { statusClass: 2, writes: 1, audits: 1 } : { statusClass: 4, writes: 0, audits: 0 })
  })

  it('security differential: ID masking adds GET read authority only to action dispatch', async () => {
    const results = []
    for (const route of ['generic', 'action']) {
      const { app, db } = await setup(withPlugin(idMask))
      const get = await app.fetch(request('/api/record/open'))
      expect(get.status).toBe(403)
      const response = await app.fetch(request(route === 'generic' ? '/commands/record/close' : '/api/record/open/actions/close', true, route === 'generic' ? { id: 'open' } : {}))
      if (route === 'action') expect(await response.text()).toBe(await get.text())
      results.push({ status: response.status,
        writes: await db.prepare('SELECT sum(version-1) AS n FROM record').first('n'),
        audits: await db.prepare('SELECT count(*) AS n FROM audit_outbox').first('n') })
    }
    // Generic commands retain their existing write authority (the binding non-goal).
    expect(results).toEqual([{ status: 200, writes: 1, audits: 1 }, { status: 403, writes: 0, audits: 0 }])
  })
}
