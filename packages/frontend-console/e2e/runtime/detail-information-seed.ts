import { getPlatformProxy } from 'wrangler'
import { resolve } from 'node:path'
import { detailInformationConfig as config } from './detail-information-config'
import { initialSchema } from '../../../core/src/migrations/schema'
import { KernelRegistry } from '../../../core/src/kernel/registry'
import { sha256 } from '../../../core/src/crypto'

const [configPath, persist] = process.argv.slice(2)
const proxy = await getPlatformProxy<any>({ configPath, remoteBindings: false, persist: { path: resolve(persist, 'v3') } })
try {
  await proxy.env.DB.exec(initialSchema(config).replaceAll('\n', ' '))
  await new KernelRegistry(config).applyMigrations(proxy.env.DB)
  await proxy.env.DB.exec("INSERT INTO organizations VALUES ('org-a','Neutral organization')")
  const now = '2026-11-15T08:30:00.000Z'
  for (const role of ['owner', 'viewer']) {
    await proxy.env.DB.prepare('INSERT INTO users VALUES (?,?,?,?,?)').bind(role, `${role}@example.test`, '', '', now).run()
    await proxy.env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(role, `${role} Example`, `${role}@example.test`, now, now).run()
    await proxy.env.DB.prepare('INSERT INTO identity_profiles (user_id,first_name,last_name,updated_at) VALUES (?,?,?,?)').bind(role, role, 'Example', now).run()
    await proxy.env.DB.prepare('INSERT INTO memberships VALUES (?,?,?)').bind(role, 'org-a', role).run()
    await proxy.env.DB.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(await sha256(`w29-${role}-session`), role, new Date(Date.now() + 3600000).toISOString()).run()
  }
  for (const [id, note, enabled, parent] of [
    ['populated', 'Žádost byla ověřena.\nDoplňující informace zůstávají u tohoto záznamu.', 0, 'populated'],
    ['missing', null, 0, null], ['not-applicable', 'Hidden conditional content', 1, 'populated'],
  ]) {
    await proxy.env.DB.prepare('INSERT INTO specimens (id,organization_id,name,note,quantity,enabled,state,parent_id,created_at,updated_at) VALUES (?,\'org-a\',?,?,12,?,\'active\',?,?,?)')
      .bind(id, 'Žaneta Šťastná Dlouhá — koordinátorka odborné péče', note, enabled, null, now, now).run()
    await proxy.env.DB.prepare('INSERT INTO containers (id,organization_id,label,quantity,state,note,enabled,specimen_id,created_at,updated_at) VALUES (?,\'org-a\',?,12,\'active\',?,?,?,?,?)')
      .bind(id, 'Členská karta — Žaneta Šťastná', note, enabled, parent ? 'populated' : null, now, now).run()
    if (parent) await proxy.env.DB.prepare('UPDATE specimens SET parent_id=? WHERE id=?').bind(parent, id).run()
  }
  await proxy.env.DB.prepare("INSERT INTO folders (id,organization_id,name,note,created_at,updated_at) VALUES ('fallback','org-a','Archiv registračních údajů','Původní záznam a jeho doplňující údaje.',?,?)").bind(now, now).run()
} finally { await proxy.dispose() }
