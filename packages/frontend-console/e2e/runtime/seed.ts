import { getPlatformProxy } from 'wrangler'
import { resolve } from 'node:path'
import { neutralConfig } from './config'
import { initialSchema } from '../../../core/src/migrations/schema'
import { KernelRegistry } from '../../../core/src/kernel/registry'
import { sha256 } from '../../../core/src/crypto'
const [configPath, persist] = process.argv.slice(2)
  const proxy = await getPlatformProxy<any>({ configPath, remoteBindings: false, persist: { path: resolve(persist, 'v3') } })
  try {
    const config = neutralConfig()
    await proxy.env.DB.exec(initialSchema(config).replaceAll('\n', ' '))
    await new KernelRegistry(config).applyMigrations(proxy.env.DB)
    await proxy.env.DB.exec("INSERT INTO organizations VALUES ('org-a','Neutral organization')")
    const now = new Date().toISOString()
    for (const role of ['owner', 'viewer']) {
      await proxy.env.DB.prepare('INSERT INTO users VALUES (?,?,?,?,?)').bind(role, `${role}@example.test`, '', '', now).run()
      await proxy.env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(role, `${role} Example`, `${role}@example.test`, now, now).run()
      await proxy.env.DB.prepare('INSERT INTO identity_profiles (user_id,first_name,last_name,updated_at) VALUES (?,?,?,?)').bind(role, role, 'Example', now).run()
      await proxy.env.DB.prepare('INSERT INTO memberships VALUES (?,?,?)').bind(role, 'org-a', role).run()
      await proxy.env.DB.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(await sha256(`w29-${role}-session`), role, new Date(Date.now() + 3600000).toISOString()).run()
    }
  } finally { await proxy.dispose() }
