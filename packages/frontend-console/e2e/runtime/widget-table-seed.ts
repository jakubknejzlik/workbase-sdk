import { getPlatformProxy } from 'wrangler'
import { resolve } from 'node:path'
import { widgetTableConfig as config } from './widget-table-config'
import { initialSchema } from '../../../core/src/migrations/schema'
import { KernelRegistry } from '../../../core/src/kernel/registry'
import { sha256 } from '../../../core/src/crypto'

const [configPath, persist] = process.argv.slice(2)
const proxy = await getPlatformProxy<any>({ configPath, remoteBindings: false, persist: { path: resolve(persist, 'v3') } })
try {
  await proxy.env.DB.exec(initialSchema(config).replaceAll('\n', ' '))
  await new KernelRegistry(config).applyMigrations(proxy.env.DB)
  await proxy.env.DB.exec("INSERT INTO organizations VALUES ('org-a','Synthetic workspace')")
  const now = '2026-11-24T10:00:00.000Z'
  await proxy.env.DB.prepare('INSERT INTO users VALUES (?,?,?,?,?)').bind('owner', 'alex@example.test', '', '', now).run()
  await proxy.env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind('owner', 'Alex Example', 'alex@example.test', now, now).run()
  await proxy.env.DB.prepare('INSERT INTO identity_profiles (user_id,first_name,last_name,updated_at) VALUES (?,?,?,?)').bind('owner', 'Alex', 'Example', now).run()
  await proxy.env.DB.prepare('INSERT INTO memberships VALUES (?,?,?)').bind('owner', 'org-a', 'owner').run()
  await proxy.env.DB.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(await sha256('widget-table-owner-session'), 'owner', new Date(Date.now() + 3600000).toISOString()).run()
  for (const [entity, name] of [['clients', 'Alex Example'], ['locations', 'Example location with a longer reference label']]) {
    await proxy.env.DB.prepare(`INSERT INTO ${entity} (id,organization_id,name,created_at,updated_at) VALUES ('example','org-a',?,?,?)`).bind(name, now, now).run()
  }
  for (let index = 0; index < 3; index++) {
    await proxy.env.DB.prepare("INSERT INTO specimens (id,organization_id,name,quantity,client,location,status,created_at,updated_at) VALUES (?,'org-a',?,0,'example','example',?,?,?)").bind(`booking-${index}`, 'Alex Example', index === 1 ? 'Pending confirmation' : 'Confirmed', now, now).run()
  }
} finally { await proxy.dispose() }
