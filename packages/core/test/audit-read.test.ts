import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { auditActorLabels } from '../src/audit'
import type { AuditEvent } from '../src/audit-event'
import { json, request, setup } from '@workbasehq/test-support/helpers'
import { seedAudit } from './audit-helpers'

let app: Awaited<ReturnType<typeof setup>>
const actorId = 'Ab9_'.repeat(8)
const event = (id: string, at: string, actor = actorId): AuditEvent => ({
  event_id: id, occurred_at: at, instance_id: 'sample', organization_id: 'org-a',
  actor: { type: 'user', id: actor }, operation: 'memberships.updated', entity: 'memberships',
  entity_id: actorId, correlation_id: 'trace', schema_version: 1, changes: {},
})
beforeEach(async () => {
  app = await setup()
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users SELECT ?,?,password_hash,salt,created_at FROM users WHERE id=?').bind(actorId, 'actor@example.test', 'owner-a'),
    env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(actorId, 'Legacy label', 'actor@example.test', '2026-10-29', '2026-10-29'),
    env.DB.prepare('INSERT INTO memberships VALUES (?,?,?)').bind(actorId, 'org-a', 'viewer'),
    env.DB.prepare('INSERT INTO identity_profiles (user_id,first_name,last_name,updated_at) VALUES (?,?,?,?)').bind(actorId, ' Ada ', ' Lovelace ', '2026-10-29'),
  ])
})

it('returns newest audit events with actor labels in the same response and pages toward older events', async () => {
  const older = event('older', '2026-10-27T00:00:00.000Z')
  const newer = event('newer', '2026-10-29T00:00:00.000Z')
  await seedAudit(older); await seedAudit(newer)
  const path = `/audit/events?limit=1&entity=memberships&entity_id=${actorId}&from=2026-10-27&to=2026-10-29`
  const first = await json(await request(app, path))
  expect(first.data).toEqual([{ ...newer, actor: { ...newer.actor, label: 'Ada Lovelace' } }])
  expect(first.next_cursor).toBeTruthy()
  const second = await json(await request(app, `${path}&cursor=${encodeURIComponent(first.next_cursor)}`))
  expect(second.data).toEqual([{ ...older, actor: { ...older.actor, label: 'Ada Lovelace' } }])
  expect(second.next_cursor).toBeNull()
})

it('resolves repeated actors with one batch and falls back to IDs, never email or another tenant name', async () => {
  await env.DB.prepare('DELETE FROM identity_profiles WHERE user_id=?').bind(actorId).run()
  const statements: string[] = []
  const observed = new Proxy(env.DB, { get(target, property) {
    if (property === 'prepare') return (sql: string) => { statements.push(sql); return target.prepare(sql) }
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
  } })
  const events = [event('a', '', actorId), event('b', '', actorId), event('c', '', 'owner-b'), event('d', '', 'deleted-user')]
  const labels = async () => (await auditActorLabels(observed, 'org-a', events)).map(row => (row.actor as typeof row.actor & { label: string }).label)
  expect(await labels()).toEqual(['Legacy label', 'Legacy label', 'owner-b', 'deleted-user'])
  expect(statements).toHaveLength(1)
  await env.DB.prepare('UPDATE "user" SET name=? WHERE id=?').bind('actor@example.test', actorId).run()
  expect(await labels()).toEqual([actorId, actorId, 'owner-b', 'deleted-user'])
  await env.DB.prepare('UPDATE "user" SET name=? WHERE id=?').bind('', actorId).run()
  expect(await labels()).toEqual([actorId, actorId, 'owner-b', 'deleted-user'])
  await env.DB.prepare('DELETE FROM memberships WHERE user_id=?').bind(actorId).run()
  expect(await labels()).toEqual([actorId, actorId, 'owner-b', 'deleted-user'])
})
