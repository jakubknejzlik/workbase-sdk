import { getPlatformProxy } from 'wrangler'
import { resolve } from 'node:path'
import { rowConfig } from './row-invitations-config'
import { initialSchema } from '../../../core/src/migrations/schema'
import { KernelRegistry } from '../../../core/src/kernel/registry'
import { sha256 } from '../../../core/src/crypto'
const [configPath, persist] = process.argv.slice(2)
const proxy = await getPlatformProxy<any>({ configPath, remoteBindings: false, persist: { path: resolve(persist, 'v3') } })
try {
  await proxy.env.DB.exec(initialSchema(rowConfig).replaceAll('\n', ' '))
  await new KernelRegistry(rowConfig).applyMigrations(proxy.env.DB)
  await proxy.env.DB.exec("INSERT INTO organizations VALUES ('org-a','Test organizace')")
  const now = new Date().toISOString()
  for (const role of ['owner', 'member']) {
    await proxy.env.DB.prepare('INSERT INTO users (id,organization_id,email,name,created_at,updated_at) VALUES (?,\'org-a\',?,?,?,?)').bind(role, `${role}@example.test`, role, now, now).run()
    await proxy.env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(role, role, `${role}@example.test`, now, now).run()
    await proxy.env.DB.prepare('INSERT INTO identity_profiles (user_id,first_name,last_name,updated_at) VALUES (?,?,?,?)').bind(role, role, 'Example', now).run()
    await proxy.env.DB.prepare('INSERT INTO identities VALUES (?,\'local\',\'local\',?,?)').bind(role, role, now).run()
    await proxy.env.DB.prepare('INSERT INTO memberships VALUES (?,\'org-a\',?)').bind(role, role).run()
    await proxy.env.DB.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(await sha256(`row-${role}-session`), role, new Date(Date.now() + 3600000).toISOString()).run()
  }
  for (const [id, name] of [['one', 'Lenka'], ['two', 'Petra']]) await proxy.env.DB.prepare('INSERT INTO people (id,organization_id,name,created_at,updated_at) VALUES (?,\'org-a\',?,?,?)').bind(id, name, now, now).run()
} finally { await proxy.dispose() }
