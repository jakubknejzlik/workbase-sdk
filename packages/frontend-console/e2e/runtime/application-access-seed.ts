import { getPlatformProxy } from 'wrangler'
import { resolve } from 'node:path'
import { applicationAccessConfig as config } from './application-access-config'
import { bootstrap } from '../../../test-support/src/bootstrap'
import { sha256 } from '../../../core/src/crypto'
const [configPath, persist] = process.argv.slice(2)
const proxy = await getPlatformProxy<any>({ configPath, remoteBindings: false, persist: { path: resolve(persist, 'v3') } })
try {
  await bootstrap(proxy.env.DB, config)
  await proxy.env.DB.exec("INSERT INTO organizations VALUES ('org-a','Synthetic access workspace')")
  const now = new Date().toISOString()
  for (const [id, role, name] of [['admin', 'admin', 'Owner Example'], ['staff', 'staff', 'Staff Example'], ['free', 'staff', 'Jana Eligible'], ['blocked', 'staff', 'Pavel Linked']]) {
    await proxy.env.DB.prepare("INSERT INTO users (id,organization_id,email,name,role,created_at,updated_at) VALUES (?,'org-a',?,?,?,?,?)").bind(id, `${id}@example.test`, name, role, now, now).run()
    await proxy.env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(id, name, `${id}@example.test`, now, now).run()
    await proxy.env.DB.prepare('INSERT INTO identity_profiles (user_id,first_name,last_name,updated_at) VALUES (?,?,?,?)').bind(id, name.split(' ')[0], name.split(' ')[1], now).run()
    await proxy.env.DB.prepare("INSERT INTO identities VALUES (?,'local','local',?,?)").bind(id, id, now).run()
    await proxy.env.DB.prepare("INSERT INTO memberships VALUES (?,'org-a',?)").bind(id, role).run()
    await proxy.env.DB.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(await sha256(`access-${id}-session`), id, new Date(Date.now() + 3600000).toISOString()).run()
  }
  for (const [id, name, user] of [['one', 'No account', null], ['two', 'Pending record', null], ['three', 'Linked record', 'blocked'], ['four', 'Staff record', 'staff']]) {
    await proxy.env.DB.prepare("INSERT INTO worker (id,organization_id,name,user,created_at,updated_at) VALUES (?,'org-a',?,?,?,?)").bind(id, name, user, now, now).run()
  }
  await proxy.env.DB.prepare("INSERT INTO invitations (id,organization_id,email,role,token_hash,expires_at,inviter_id,created_at,target_entity,target_row) VALUES ('pending-link','org-a','free@example.test','staff',?,'2099-11-20T10:00:00.000Z','admin',?,'worker','two')").bind(await sha256('synthetic-not-a-real-invitation'), now).run()
} finally { await proxy.dispose() }
