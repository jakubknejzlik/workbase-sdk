import { bootstrap } from '@workbasehq/test-support/bootstrap'
import { actionFixture } from './record-actions'
import { createApp } from '../../src/app'
import { sha256 } from '../../src/crypto'

const runtime = (DB: D1Database, AUDIT_KV?: KVNamespace) => ({ DB, AUDIT_KV: AUDIT_KV ?? { put: async () => {} } as unknown as KVNamespace, INTERNAL_TOKEN: 'synthetic-actions-internal', IDENTITY: { baseURL: 'http://localhost', secret: 'synthetic-actions-secret-at-least-32', localPassword: true } })
export async function recordActionApp(db: D1Database, selected = actionFixture(), kv?: KVNamespace) {
  await bootstrap(db, selected)
  await db.exec("INSERT INTO organizations VALUES ('org-a','A'),('org-b','B')")
  for (const role of ['admin', 'staff', 'viewer']) {
    await db.prepare('INSERT INTO users (id,email,password_hash,salt,organization_id,name,role,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(role, `${role}@example.test`, 'x', 'x', 'org-a', role, role, 'now', 'now').run()
    await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(role, role, `${role}@example.test`, 'now', 'now').run()
    await db.prepare('INSERT INTO memberships VALUES (?,?,?)').bind(role, 'org-a', role).run()
    await db.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(await sha256(`synthetic-${role}`), role, new Date(Date.now() + 86400000).toISOString()).run()
  }
  for (const [id, org, state, user] of [['open', 'org-a', 'open', 'staff'], ['closed', 'org-a', 'closed', 'staff'], ['locked', 'org-a', 'locked', 'staff'], ['null', 'org-a', null, 'staff'], ['filtered', 'org-a', 'open', 'admin'], ['foreign', 'org-b', 'open', null]]) {
    await db.prepare('INSERT INTO record (id,organization_id,state,secret,user,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').bind(id, org, state, 'yes', user, 'now', 'now').run()
  }
  await db.exec("INSERT INTO worker (id,organization_id,name,created_at,updated_at) VALUES ('worker','org-a','Worker','now','now')")
  return createApp(selected, runtime(db, kv))
}
