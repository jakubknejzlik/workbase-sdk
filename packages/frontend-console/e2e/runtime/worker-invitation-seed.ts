import { getPlatformProxy } from 'wrangler'
import { resolve } from 'node:path'
import { workerInvitationConfig as config } from './worker-invitation-config'
import { bootstrap } from '../../../test-support/src/bootstrap'
import { sha256 } from '../../../core/src/crypto'

const [configPath, persist] = process.argv.slice(2)
const proxy = await getPlatformProxy<any>({ configPath, remoteBindings: false, persist: { path: resolve(persist, 'v3') } })
try {
  await bootstrap(proxy.env.DB, config)
  await proxy.env.DB.exec("INSERT INTO organizations VALUES ('org-a','Invitation workspace')")
  const now = new Date().toISOString()
  for (const [id, role] of [['admin', 'admin'], ['recipient', 'staff']]) {
    await proxy.env.DB.prepare('INSERT INTO users (id,organization_id,email,name,role,created_at,updated_at) VALUES (?,\'org-a\',?,?,?,?,?)').bind(id, `${id}@example.test`, id, role, now, now).run()
    await proxy.env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(id, id, `${id}@example.test`, now, now).run()
    await proxy.env.DB.prepare('INSERT INTO identity_profiles (user_id,first_name,last_name,updated_at) VALUES (?,?,?,?)').bind(id, id, 'Example', now).run()
    await proxy.env.DB.prepare("INSERT INTO identities VALUES (?,'local','local',?,?)").bind(id, id, now).run()
    if (role === 'admin') {
      await proxy.env.DB.prepare("INSERT INTO memberships VALUES (?,'org-a',?)").bind(id, role).run()
      await proxy.env.DB.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(await sha256('worker-admin-session'), id, new Date(Date.now() + 3600000).toISOString()).run()
    }
  }
  await proxy.env.DB.prepare("INSERT INTO worker (id,organization_id,name,created_at,updated_at) VALUES ('one','org-a','Recipient',?,?)").bind(now, now).run()
} finally { await proxy.dispose() }
