import { getPlatformProxy } from 'wrangler'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { computedConfig } from './computed-config'
import { initialSchema } from '../../../core/src/migrations/schema'
import { KernelRegistry } from '../../../core/src/kernel/registry'
import { sha256 } from '../../../core/src/crypto'
const [configPath, persist, instanceConfig] = process.argv.slice(2)
  const proxy = await getPlatformProxy<any>({ configPath, remoteBindings: false, persist: { path: resolve(persist, 'v3') } })
  try {
    const config = instanceConfig ? (await import(pathToFileURL(instanceConfig).href)).default : computedConfig
    await proxy.env.DB.exec(initialSchema(config).replaceAll('\n', ' '))
    await new KernelRegistry(config).applyMigrations(proxy.env.DB)
    await proxy.env.DB.exec("INSERT INTO organizations VALUES ('org-a','Neutral organization')")
    const now = new Date().toISOString()
    for (const role of ['owner']) {
      await proxy.env.DB.prepare('INSERT INTO users VALUES (?,?,?,?,?)').bind(role, `${role}@example.test`, '', '', now).run()
      await proxy.env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(role, `${role} Example`, `${role}@example.test`, now, now).run()
      await proxy.env.DB.prepare('INSERT INTO identity_profiles (user_id,first_name,last_name,updated_at) VALUES (?,?,?,?)').bind(role, role, 'Example', now).run()
      await proxy.env.DB.prepare('INSERT INTO memberships VALUES (?,?,?)').bind(role, 'org-a', role).run()
      await proxy.env.DB.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(await sha256(`w44-${role}-session`), role, new Date(Date.now() + 3600000).toISOString()).run()
    }
    await proxy.env.DB.prepare('INSERT INTO zakaznik(id,organization_id,jmeno,created_at,updated_at) VALUES (?,?,?,?,?)').bind('customer-a','org-a','Jana Nováková',now,now).run()
    await proxy.env.DB.prepare('INSERT INTO sluzba(id,organization_id,nazev,created_at,updated_at) VALUES (?,?,?,?,?)').bind('service-a','org-a','Úklid bytu',now,now).run()
    await proxy.env.DB.prepare('INSERT INTO rezervace(id,organization_id,termin,zakaznik,sluzba,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').bind('booking-a','org-a','2026-11-06T09:00:00.000Z','customer-a','service-a',now,now).run()
    await proxy.env.DB.prepare('INSERT INTO poznamka(id,organization_id,text,rezervace,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind('note-a','org-a','Zavolat zákaznici','booking-a',now,now).run()
  } finally { await proxy.dispose() }
