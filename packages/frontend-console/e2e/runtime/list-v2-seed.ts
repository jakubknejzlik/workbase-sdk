import { getPlatformProxy } from 'wrangler'
import { resolve } from 'node:path'
import { listV2Config as config } from './list-v2-config'
import { bootstrap } from '../../../test-support/src/bootstrap'
import { workers, seedTime } from './list-v2-data'
import { sha256 } from '../../../core/src/crypto'
const [configPath, persist] = process.argv.slice(2)
const proxy = await getPlatformProxy<any>({ configPath, remoteBindings: false, persist: { path: resolve(persist, 'v3') } })
try {
  await bootstrap(proxy.env.DB, config)
  await proxy.env.DB.exec("INSERT INTO organizations VALUES ('org-a','Synthetic access workspace')")
  const now = seedTime
  for (const [id, role, name] of [['admin', 'admin', 'Owner Example'], ['staff', 'staff', 'Staff Example'], ['linked', 'staff', 'Linked Example']]) {
    await proxy.env.DB.prepare("INSERT INTO users (id,organization_id,email,name,role,created_at,updated_at) VALUES (?,'org-a',?,?,?,?,?)").bind(id, `${id}@example.test`, name, role, now, now).run()
    await proxy.env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(id, name, `${id}@example.test`, now, now).run()
    await proxy.env.DB.prepare('INSERT INTO identity_profiles (user_id,first_name,last_name,updated_at) VALUES (?,?,?,?)').bind(id, name.split(' ')[0], name.split(' ')[1], now).run()
    await proxy.env.DB.prepare("INSERT INTO identities VALUES (?,'local','local',?,?)").bind(id, id, now).run()
    await proxy.env.DB.prepare("INSERT INTO memberships VALUES (?,'org-a',?)").bind(id, role).run()
    await proxy.env.DB.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(await sha256(`list-v2-${id}-session`), id, new Date(Date.now() + 3600000).toISOString()).run()
  }
  for (const [id, name] of [['north', 'North team'], ['south', 'South team']]) await proxy.env.DB.prepare("INSERT INTO team (id,organization_id,name,created_at,updated_at) VALUES (?,'org-a',?,?,?)").bind(id, name, now, now).run()
  for (const row of workers) await proxy.env.DB.prepare("INSERT INTO worker (id,organization_id,name,code,status,team_id,amount,due_on,approved,description,user,created_at,updated_at) VALUES (?,'org-a',?,?,?,?,?,?,?,?,?,?,?)").bind(row.id, row.name, row.code, row.status, row.team_id, row.amount, row.due_on, row.approved ? 1 : 0, row.description, row.user, now, now).run()
  for (const [id, target, expires] of [['pending', 'w002', '2099-01-01T00:00:00.000Z'], ['expired', 'w005', '2020-01-01T00:00:00.000Z']]) await proxy.env.DB.prepare("INSERT INTO invitations (id,organization_id,email,role,token_hash,expires_at,inviter_id,created_at,target_entity,target_row) VALUES (?,'org-a',?,'staff',?,?,'admin',?,'worker',?)").bind(id, `${id}@example.test`, await sha256(`synthetic-${id}`), expires, now, target).run()
} finally { await proxy.dispose() }
