import { env } from 'cloudflare:workers'
import { reset } from 'cloudflare:test'
import sample from '../../core/test/fixtures/sample/config'
import { seedAccounts } from '../../core/test/fixtures/accounts/seed'
import { initialSchema } from '../../core/src/migrations/schema'
import type { InstanceConfig } from '../../core/src/config'
import { passwordHash, randomSalt, sha256 } from '../../core/src/crypto'
import { KernelRegistry } from '../../core/src/kernel/registry'
import { createApp } from '../../core/src/app'
export const syntheticPassword = 'Synthetic-password-for-tests'
export const runtime = () => ({ DB: env.DB, EVENTS_QUEUE: env.EVENTS_QUEUE, AUDIT_KV: env.AUDIT_KV, INTERNAL_TOKEN: env.INTERNAL_TOKEN, IDENTITY: { baseURL: 'http://localhost', secret: 'synthetic-workbase-test-secret-at-least-32', localPassword: true }, WEBHOOK_EVENTS: 'booking.created' })
export async function setup(config: InstanceConfig = sample, seed: (db: D1Database) => Promise<unknown> = config.id === 'accounts' ? seedAccounts : seedActors) {
  await reset()
  await env.DB.exec(initialSchema(config).replaceAll('\n', ' '))
  await new KernelRegistry(config).applyMigrations(env.DB)
  await seed(env.DB)
  return createApp(config, runtime())
}
export async function seedActors(db: D1Database = env.DB, names = ['Organization A', 'Organization B']) {
  await db.prepare('INSERT INTO organizations VALUES (?,?),(?,?)').bind('org-a', names[0], 'org-b', names[1]).run()
  for (const [id, org, role] of [['owner-a', 'org-a', 'owner'], ['dispatcher-a', 'org-a', 'dispatcher'], ['viewer-a', 'org-a', 'viewer'], ['owner-b', 'org-b', 'owner']]) {
    const salt = randomSalt()
    await db.batch([
      db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').bind(id, `${id.replace('-', '.')}@example.test`, await passwordHash(syntheticPassword, salt), salt, new Date().toISOString()),
      db.prepare("INSERT INTO identities VALUES (?,'local','local',?,?)").bind(id, id, new Date().toISOString()),
      db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(id, id, `${id.replace('-', '.')}@example.test`, new Date().toISOString(), new Date().toISOString()),
      db.prepare('INSERT INTO memberships VALUES (?,?,?)').bind(id, org, role),
      db.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(await sha256(`synthetic-${id}`), id, new Date(Date.now() + 86400000).toISOString()),
    ])
  }
}
export function request(app: ReturnType<typeof createApp>, path: string, method = 'GET', body?: unknown, user = 'owner-a', org = 'org-a', headers: Record<string, string> = {}) {
  return app.request(`http://localhost${path}`, { method, headers: { Authorization: `Bearer synthetic-${user}`, 'X-Organization-Id': org, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
export async function json(response: Response) { return response.json() as Promise<any> }
export async function insertDomain(org = 'org-a') {
  const now = new Date().toISOString()
  await env.DB.batch([
    env.DB.prepare('INSERT INTO clients (id,organization_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').bind(`client-${org}`, org, `Client ${org}`, now, now),
    env.DB.prepare('INSERT INTO workers (id,organization_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').bind(`worker-${org}`, org, 'Synthetic worker', now, now),
    env.DB.prepare('INSERT INTO jobs (id,organization_id,title,client_id,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind(`job-${org}`, org, 'Synthetic job', `client-${org}`, now, now),
    env.DB.prepare('INSERT INTO slots (id,organization_id,job_id,worker_id,starts_at,capacity,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').bind(`slot-${org}`, org, `job-${org}`, `worker-${org}`, now, 3, now, now),
  ])
  return { clientId: `client-${org}`, jobId: `job-${org}`, slotId: `slot-${org}` }
}

/** Complete legacy invitation fixtures explicitly; authentication itself never completes a profile. */
export async function completeInvitationProfiles() {
  await env.DB.prepare(`INSERT OR IGNORE INTO identity_profiles (user_id,first_name,last_name,updated_at)
    SELECT id,'Existing','Person',? FROM "user"`).bind(new Date().toISOString()).run()
}
