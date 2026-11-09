import { env } from 'cloudflare:workers'
import { reset } from 'cloudflare:test'
import { beforeEach, expect, it } from 'vitest'
import { z } from 'zod'
import { identity } from '@workbasehq/plugins/identity'
import { localAuth } from '@workbasehq/plugins/local-auth'
import { legacyPermissions } from '@workbasehq/plugins/permissions'
import { members } from '@workbasehq/plugins/members'
import { organizations } from '@workbasehq/plugins/organizations'
import { machineCredentials } from '@workbasehq/plugins/machine-credentials'
import { mailOutbox } from '@workbasehq/plugins/mail-outbox'
import { request, json, runtime } from '@workbasehq/test-support/helpers'
import { defineInstance, serializableInstanceConfig } from '../src/config'
import { createApp } from '../src/app'
import { initialSchema } from '../src/migrations/schema'
import { KernelRegistry } from '../src/kernel/registry'
import { requireScope, resolveActor } from '../src/authorization'
import { sha256 } from '../src/crypto'
import { compileRoot } from '../src/query/compiler'
import { validateQuery, type Filter } from '../src/query/schema'
import { writeFilter } from '../src/execution/policies'
import { executeAtomic } from '../src/execution/atomic'
import { coreExecutionContext } from '../src/execution/context'
import { D1AtomicReader, D1AtomicStore } from '../src/execution/d1'
import { createCommandRegistry } from '../src/commands'
import type { AtomicOperation, AtomicStore, GuardedStatement } from '../src/execution/types'

const entities = ['users', 'people', 'teams', 'jobs']
function baseConfig() {
  const person = { fields: { name: { type: 'string' as const }, user: { type: 'ref' as const, entity: 'users', userLink: true } }, relations: { account: { field: 'user', entity: 'users' } } }
  return defineInstance({ id: 'linked_policy', revision: 1, roles: ['owner', 'viewer'], account: { entity: 'users' }, interactive: true,
    plugins: [identity, localAuth, legacyPermissions, members, organizations, machineCredentials(), mailOutbox()],
    entities: { users: { fields: { name: { type: 'string' } } }, people: person, teams: person, jobs: { fields: { title: { type: 'string' } } } },
    permissions: Object.fromEntries(['owner', 'viewer'].map(role => [role, Object.fromEntries(entities.map(entity => [entity, ['read', 'create', 'update', 'delete'] as const]))])),
    policies: Object.fromEntries(entities.map(entity => [entity, { owner: 'all', viewer: entity === 'jobs' ? 'all' : 'none' }])),
  })
}
function config(where: Filter = { actorLinkedIn: 'people' }) {
  const base = baseConfig()
  return defineInstance({ ...base, policies: { ...base.policies, jobs: { owner: 'all', viewer: { where } } } })
}
beforeEach(async () => {
  await reset()
  const base = baseConfig()
  await env.DB.exec(initialSchema(base).replaceAll('\n', ' '))
  await new KernelRegistry(base).applyMigrations(env.DB)
  await env.DB.exec("INSERT INTO organizations VALUES ('org-a','A'),('org-b','B');")
  for (const [id, org] of [['alice', 'org-a'], ['bob', 'org-a'], ['foreign', 'org-b']]) {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO users (id,organization_id,email,name,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind(id, org, `${id}@example.test`, id, 'now', 'now'),
      env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(id, id, `${id}@example.test`, 'now', 'now'),
      env.DB.prepare("INSERT INTO identities VALUES (?,'local','local',?,'now')").bind(id, id),
      env.DB.prepare('INSERT INTO memberships VALUES (?,?,?)').bind(id, org, 'viewer'),
      env.DB.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(await sha256(`synthetic-${id}`), id, '2099-01-01T00:00:00.000Z'),
    ])
  }
  await env.DB.exec("INSERT INTO people (id,organization_id,name,user,created_at,updated_at) VALUES ('person-a','org-a','A','alice','now','now'),('person-b','org-b','B','foreign','now','now'); INSERT INTO teams (id,organization_id,name,user,created_at,updated_at) VALUES ('team-a','org-a','A','alice','now','now'); INSERT INTO jobs (id,organization_id,title,created_at,updated_at) VALUES ('job-a','org-a','A','now','now'),('job-b','org-a','B','now','now'),('job-foreign','org-b','Foreign','now','now');")
})
const query = { entity: 'jobs', select: ['id'], limit: 100 }
async function ask(c = config(), actor = 'alice', extra = {}) {
  return request(createApp(c, runtime()), '/query', 'POST', { ...query, ...extra }, actor)
}
async function ids(response: Response) {
  expect(response.status).toBe(200)
  return (await json(response)).data.map((row: { id: string }) => row.id).sort()
}
async function live(kernel: KernelRegistry, credential = 'synthetic-alice') {
  return requireScope(await resolveActor(new Request('http://localhost', { headers: { Authorization: `Bearer ${credential}` } }), runtime(), kernel.config), 'org-a', kernel.config)
}
async function token(issuer = 'alice') {
  const credential = 'wb_synthetic_linked_policy'
  await env.DB.prepare('INSERT INTO access_tokens (id,organization_id,issuer_id,name,token_hash,prefix,role,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind('agent', 'org-a', issuer, 'Linked policy', await sha256(credential), 'wb_synthetic', 'viewer', '2099-01-01T00:00:00.000Z', 'now').run()
  return credential
}
function operation(statements: GuardedStatement[]): AtomicOperation {
  return { name: 'jobs/change', permission: { entity: 'jobs', operation: 'update' }, input: z.strictObject({}), plan: () => ({
    rules: [{ name: 'change', statements }], result: { status: 200, body: { ok: true } }, event: { entity: 'jobs', entityId: 'job-a', operation: 'job.changed' },
  }) }
}
const update = { sql: 'UPDATE jobs SET title=? WHERE id=?', bindings: ['Changed', 'job-a'], expectRows: 1 as const }
async function atomic(statements = [update] as GuardedStatement[], store: AtomicStore = new D1AtomicStore(env.DB), credential?: string, where?: Filter) {
  const op = operation(statements); const c = config(where); c.commands.push(op.name)
  const kernel = new KernelRegistry(c, { commands: createCommandRegistry([op]) })
  return executeAtomic(op, {}, coreExecutionContext(kernel.config, await live(kernel, credential), store, new D1AtomicReader(env.DB), 'linked-write'))
}
async function rolledBack() {
  expect(await env.DB.prepare("SELECT title FROM jobs WHERE id='job-a'").first('title')).toBe('A')
  for (const table of ['audit_outbox', 'idempotency_keys', 'atomic_assert']) expect(await env.DB.prepare(`SELECT count(*) n FROM ${table}`).first('n')).toBe(0)
}

it('same-org link allows all unrelated jobs without inspecting the linked entity read policy', async () => {
  expect(await ids(await ask())).toEqual(['job-a', 'job-b'])
  const response = await request(createApp(config(), runtime()), '/query', 'POST', { entity: 'people', select: ['id'], limit: 10 }, 'alice')
  expect(await ids(response)).toEqual([])
})
it('foreign-org link denies even when the actor is a member in both organizations', async () => {
  await env.DB.prepare("INSERT INTO memberships VALUES ('foreign','org-a','viewer')").run()
  expect(await ids(await ask(config(), 'foreign'))).toEqual([])
})
it('no link denies unrelated jobs', async () => {
  expect(await ids(await ask(config(), 'bob'))).toEqual([])
})
it('multiple entities linked to the same account are checked independently', async () => {
  const both = config({ and: [{ actorLinkedIn: 'people' }, { actorLinkedIn: 'teams' }] })
  expect(await ids(await ask(both))).toEqual(['job-a', 'job-b'])
  await env.DB.exec("UPDATE people SET user=NULL WHERE id='person-a';")
  expect(await ids(await ask(both))).toEqual([])
  expect(await ids(await ask(config({ actorLinkedIn: 'teams' })))).toEqual(['job-a', 'job-b'])
})
it('live unlink denies the next request using the same app and credential', async () => {
  const app = createApp(config(), runtime())
  const call = () => request(app, '/query', 'POST', query, 'alice')
  expect(await ids(await call())).toEqual(['job-a', 'job-b'])
  await env.DB.exec("UPDATE people SET user=NULL WHERE id='person-a';")
  expect(await ids(await call())).toEqual([])
})
it('live member removal denies the next request even if a stale link remains', async () => {
  const app = createApp(config(), runtime())
  const call = () => request(app, '/query', 'POST', query, 'alice')
  expect(await ids(await call())).toEqual(['job-a', 'job-b'])
  await env.DB.exec("DELETE FROM memberships WHERE user_id='alice' AND organization_id='org-a';")
  expect((await call()).status).toBe(403)
})
it('token issuer authority uses the live issuer rather than token identity or client values', async () => {
  const credential = await token(); const app = createApp(config(), runtime())
  const call = () => request(app, '/query', 'POST', query, 'bob', 'org-a', { Authorization: `Bearer ${credential}` })
  expect(await ids(await call())).toEqual(['job-a', 'job-b'])
  await env.DB.exec("UPDATE access_tokens SET issuer_id='bob' WHERE id='agent';")
  expect(await ids(await call())).toEqual([])
  await env.DB.exec("UPDATE access_tokens SET issuer_id='alice' WHERE id='agent'; DELETE FROM memberships WHERE user_id='alice';")
  expect(await ids(await call())).toEqual([])
})
it('boolean composition supports actorLinkedIn under or and not', async () => {
  expect(await ids(await ask(config({ or: [{ actorLinkedIn: 'people' }, { title: { eq: 'A' } }] }), 'bob'))).toEqual(['job-a'])
  expect(await ids(await ask(config({ not: { actorLinkedIn: 'people' } }), 'bob'))).toEqual(['job-a', 'job-b'])
  expect(await ids(await ask(config({ not: { actorLinkedIn: 'people' } })))).toEqual([])
})
it('atomic writes allow a live link and replay is denied after unlink', async () => {
  expect((await atomic()).status).toBe(200)
  await env.DB.exec("UPDATE people SET user=NULL WHERE id='person-a';")
  await expect(atomic()).rejects.toMatchObject({ status: 403, code: 'policy_violation' })
  expect(await env.DB.prepare('SELECT count(*) n FROM audit_outbox').first('n')).toBe(1)
})
it.each([
  ['unlink', "UPDATE people SET user=NULL WHERE id='person-a'"],
  ['member removal', "DELETE FROM memberships WHERE user_id='alice' AND organization_id='org-a'"],
])('atomic pre-image race rechecks live %s inside the batch', async (_name, sql) => {
  let intercepted = false
  const store: AtomicStore = { async run(plan) { intercepted = true; await env.DB.exec(sql); return new D1AtomicStore(env.DB).run(plan) } }
  await expect(atomic([update], store)).rejects.toMatchObject({ status: 403, code: 'policy_violation' })
  expect(intercepted).toBe(true); await rolledBack()
})
it.each([
  ['unlink', "UPDATE people SET user=NULL WHERE id='person-a'"],
  ['member removal', "DELETE FROM memberships WHERE user_id='alice' AND organization_id='org-a'"],
])('atomic post-image race rolls back a triggered %s with the write', async (_name, sql) => {
  await env.DB.exec(`CREATE TRIGGER lose_link AFTER UPDATE ON jobs BEGIN ${sql}; END;`)
  await expect(atomic()).rejects.toMatchObject({ status: 403, code: 'policy_violation' })
  await rolledBack()
  expect(await env.DB.prepare("SELECT user FROM people WHERE id='person-a'").first('user')).toBe('alice')
  expect(await env.DB.prepare("SELECT role FROM memberships WHERE user_id='alice' AND organization_id='org-a'").first('role')).toBe('viewer')
})
it.each([
  ['revocation', "UPDATE access_tokens SET revoked_at='now' WHERE id='agent'"],
  ['issuer change', "UPDATE access_tokens SET issuer_id='bob' WHERE id='agent'"],
  ['expiry', "UPDATE access_tokens SET expires_at='2000-01-01T00:00:00.000Z' WHERE id='agent'"],
])('atomic token authority race denies %s inside the batch', async (_name, sql) => {
  const credential = await token()
  const store: AtomicStore = { async run(plan) { await env.DB.exec(sql); return new D1AtomicStore(env.DB).run(plan) } }
  await expect(atomic([update], store, credential)).rejects.toMatchObject({ status: 403, code: 'policy_violation' })
  await rolledBack()
})
it.each([
  { not: { actorLinkedIn: 'people' } },
  { not: { or: [{ actorLinkedIn: 'people' }, { title: { eq: 'Denied' } }] } },
  { not: { not: { actorLinkedIn: 'people' } } },
])('atomic member removal cannot grant access through negation: %j', async where => {
  await env.DB.exec("UPDATE people SET user=NULL WHERE id='person-a';")
  const store: AtomicStore = { async run(plan) { await env.DB.exec("DELETE FROM memberships WHERE user_id='alice';"); return new D1AtomicStore(env.DB).run(plan) } }
  await expect(atomic([update], store, undefined, where)).rejects.toMatchObject({ status: 403, code: 'policy_violation' })
  await rolledBack()
})
it('atomic insert and organization post-images cannot escape the linked scope', async () => {
  for (const statement of [
    { sql: "INSERT INTO jobs (id,organization_id,title,created_at,updated_at) VALUES ('new','org-b','Bad','now','now')", expectRows: 1 as const },
    { sql: "UPDATE jobs SET organization_id='org-b' WHERE id='job-a'", expectRows: 1 as const },
  ]) {
    await expect(atomic([statement])).rejects.toMatchObject({ status: 403, code: 'policy_violation' })
    await rolledBack()
  }
})
it.each([{ actorLinkedIn: 'people' }, { not: { actorLinkedIn: 'people' } }, { actorLinkedIn: { entity: 'people', user: 'alice' } }])('client query using actorLinkedIn is rejected: %j', async where => {
  const response = await ask(baseConfig(), 'alice', { where })
  expect(response.status).toBe(400)
  expect((await json(response)).error).toBe('query_invalid')
})
it.each(['jobs', 'missing', 'users'])('entity without a protected user link is rejected at validation: %s', entity => {
  expect(() => config({ actorLinkedIn: entity })).toThrow(/actorLinkedIn.*protected user link/)
})
it('an ordinary ref to users cannot masquerade as a protected user link', () => {
  const base = baseConfig(); delete base.entities.people.fields.user.userLink
  expect(() => defineInstance({ ...base, policies: { jobs: { viewer: { where: { actorLinkedIn: 'people' } } } } })).toThrow(/actorLinkedIn.*protected user link/)
})
it('config validation and serialization preserve actorLinkedIn', () => {
  const c = config({ or: [{ actorLinkedIn: 'people' }, { actorLinkedIn: 'teams' }] })
  expect(defineInstance({ ...JSON.parse(JSON.stringify(serializableInstanceConfig(c))), plugins: c.plugins }).policies).toEqual(c.policies)
})
it.each(['user', 'token'])('SQL plan stays one indexed EXISTS per link plus one live %s authority check', async actor => {
  const kernel = new KernelRegistry(config()); const scope = await live(kernel, actor === 'token' ? await token() : undefined)
  const read = compileRoot(kernel, scope, validateQuery(kernel, scope, query).query)
  const write = writeFilter(kernel, scope, 'jobs')
  for (const statement of [read, { sql: `SELECT id FROM jobs WHERE ${write.sql}`, bindings: write.bindings ?? [] }]) {
    expect(statement.sql.match(/\bEXISTS\s*\(/gi)).toHaveLength(2)
    expect(statement.sql.match(/FROM memberships AS __actor_link_member/g)).toHaveLength(1)
    expect(statement.sql.match(/\bJOIN "people"|\bFROM "people"/gi)).toHaveLength(1)
    expect(statement.bindings).toContain('alice')
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).bind(...statement.bindings).all<{ detail: string }>()
    const details = plan.results.map(row => row.detail).join('\n')
    expect(details).toMatch(/SEARCH .* USING (?:COVERING )?INDEX people_user_idx \(organization_id=\? AND user=\?\)/)
    expect(details).not.toMatch(/SCAN __actor_link/)
  }
})

function relationConfig(where: Filter) {
  const base = baseConfig()
  return defineInstance({ ...base,
    entities: { ...base.entities,
      teams: { ...base.entities.teams, fields: { ...base.entities.teams.fields, job_id: { type: 'ref', entity: 'jobs' } } },
      jobs: { ...base.entities.jobs, relations: { teams: { entity: 'teams', field: 'job_id', many: true } } },
    },
    policies: { ...base.policies, teams: { owner: 'all', viewer: 'all' }, jobs: { owner: 'all', viewer: { where } } },
  })
}
async function relationAtomic(where: Filter, raceSql: string, credential?: string, trigger = false) {
  await env.DB.exec("ALTER TABLE teams ADD COLUMN job_id TEXT REFERENCES jobs(id); UPDATE teams SET job_id='job-a' WHERE id='team-a';")
  const c = relationConfig(where)
  const op = operation([update]); c.commands.push(op.name)
  const kernel = new KernelRegistry(c, { commands: createCommandRegistry([op]) })
  if (trigger) await env.DB.exec(`CREATE TRIGGER lose_authority AFTER UPDATE ON jobs BEGIN ${raceSql}; END;`)
  const store: AtomicStore = { async run(plan) { if (!trigger) await env.DB.exec(raceSql); return new D1AtomicStore(env.DB).run(plan) } }
  return executeAtomic(op, {}, coreExecutionContext(kernel.config, await live(kernel, credential), store, new D1AtomicReader(env.DB), 'relation-race'))
}

// Review-1 unexpected-commit probes, retained as regressions.
it('PROBE relation none denies a removed member at atomic execution', async () => {
  await expect(relationAtomic({ teams: { none: { actorLinkedIn: 'people' } } }, "DELETE FROM memberships WHERE user_id='alice' AND organization_id='org-a'"))
    .rejects.toMatchObject({ status: 403, code: 'policy_violation' })
  await rolledBack()
})
it('PROBE negated relation denies a revoked token at atomic execution', async () => {
  const credential = await token()
  await expect(relationAtomic({ not: { teams: { some: { actorLinkedIn: 'people' } } } }, "UPDATE access_tokens SET revoked_at='now' WHERE id='agent'", credential))
    .rejects.toMatchObject({ status: 403, code: 'policy_violation' })
  await rolledBack()
})
it('PROBE relation none post-image denies removed member', async () => {
  await expect(relationAtomic({ teams: { none: { not: { actorLinkedIn: 'people' } } } }, "DELETE FROM memberships WHERE user_id='alice' AND organization_id='org-a'", undefined, true))
    .rejects.toMatchObject({ status: 403, code: 'policy_violation' })
  await rolledBack()
  expect(await env.DB.prepare("SELECT role FROM memberships WHERE user_id='alice' AND organization_id='org-a'").first('role')).toBe('viewer')
})
it('PROBE direct actorLinkedIn denies token expiring between prepare and batch', async () => {
  const credential = await token()
  await env.DB.prepare("UPDATE access_tokens SET expires_at=? WHERE id='agent'").bind(new Date(Date.now() + 500).toISOString()).run()
  let executed = false
  const store: AtomicStore = { async run(plan) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    executed = true
    return new D1AtomicStore(env.DB).run(plan)
  } }
  await expect(atomic([update], store, credential)).rejects.toMatchObject({ status: 403, code: 'policy_violation' })
  expect(executed).toBe(true)
  await rolledBack()
})

const nestedPolicies: { name: string; where: Filter; unlink?: boolean }[] = [
  { name: 'none', where: { teams: { none: { actorLinkedIn: 'people' } } }, unlink: true },
  { name: 'not some', where: { not: { teams: { some: { actorLinkedIn: 'people' } } } }, unlink: true },
  // The supported grammar expresses every(P) as none(not(P)).
  { name: 'every (none + not)', where: { teams: { none: { not: { actorLinkedIn: 'people' } } } } },
  { name: 'or with nested none/not', where: { or: [{ title: { eq: 'A' } }, { teams: { none: { not: { not: { actorLinkedIn: 'people' } } } } }] }, unlink: true },
]
const revokedAuthorities = [
  { name: 'membership', sql: "DELETE FROM memberships WHERE user_id='alice' AND organization_id='org-a'" },
  { name: 'token', sql: "UPDATE access_tokens SET revoked_at='now' WHERE id='agent'" },
]
const nestedRaces = nestedPolicies.flatMap(policy => revokedAuthorities.flatMap(authority => [false, true].flatMap(empty => [false, true].map(trigger => ({
  ...policy, authority: authority.name, sql: authority.sql, empty, trigger,
})))))
it.each(nestedRaces)('$name denies revoked $authority (empty=$empty, post-image=$trigger)', async ({ where, unlink, authority, sql, empty, trigger }) => {
  if (unlink) await env.DB.exec("UPDATE people SET user=NULL WHERE id='person-a';")
  if (empty) await env.DB.exec("DELETE FROM teams WHERE id='team-a';")
  const credential = authority === 'token' ? await token() : undefined
  await expect(relationAtomic(where, sql, credential, trigger)).rejects.toMatchObject({ status: 403, code: 'policy_violation' })
  await rolledBack()
  if (trigger) {
    expect(await env.DB.prepare("SELECT role FROM memberships WHERE user_id='alice' AND organization_id='org-a'").first('role')).toBe('viewer')
    if (credential) expect(await env.DB.prepare("SELECT revoked_at FROM access_tokens WHERE id='agent'").first('revoked_at')).toBeNull()
  }
})
const nestedReadRaces = nestedPolicies.flatMap(policy => revokedAuthorities.flatMap(authority => [false, true].map(empty => ({ ...policy, authority: authority.name, sql: authority.sql, empty }))))
it.each(nestedReadRaces)('prepared read with $name denies revoked $authority (empty=$empty)', async ({ where, unlink, authority, sql, empty }) => {
  await env.DB.exec("ALTER TABLE teams ADD COLUMN job_id TEXT REFERENCES jobs(id); UPDATE teams SET job_id='job-a' WHERE id='team-a';")
  if (unlink) await env.DB.exec("UPDATE people SET user=NULL WHERE id='person-a';")
  if (empty) await env.DB.exec("DELETE FROM teams WHERE id='team-a';")
  const kernel = new KernelRegistry(relationConfig(where))
  const scope = await live(kernel, authority === 'token' ? await token() : undefined)
  const read = compileRoot(kernel, scope, validateQuery(kernel, scope, query).query)
  const prepared = env.DB.prepare(read.sql).bind(...read.bindings)
  expect((await prepared.all<{ id: string }>()).results.map(row => row.id)).toContain('job-a')
  await env.DB.exec(sql)
  expect((await prepared.all()).results).toEqual([])
})
it('prepared read denies a token expiring before database execution', async () => {
  const credential = await token()
  const kernel = new KernelRegistry(config())
  const scope = await live(kernel, credential)
  const read = compileRoot(kernel, scope, validateQuery(kernel, scope, query).query)
  const prepared = env.DB.prepare(read.sql).bind(...read.bindings)
  await env.DB.prepare("UPDATE access_tokens SET expires_at=? WHERE id='agent'").bind(new Date(Date.now() + 500).toISOString()).run()
  expect((await prepared.all()).results).toHaveLength(2)
  await new Promise(resolve => setTimeout(resolve, 1000))
  expect((await prepared.all()).results).toEqual([])
})
it('post-image database-time token expiry rolls back the write and audit', async () => {
  const credential = await token()
  await env.DB.exec("CREATE TRIGGER expire_token AFTER UPDATE ON jobs BEGIN UPDATE access_tokens SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='agent'; END;")
  await expect(atomic([update], undefined, credential)).rejects.toMatchObject({ status: 403, code: 'policy_violation' })
  await rolledBack()
  expect(await env.DB.prepare("SELECT expires_at FROM access_tokens WHERE id='agent'").first('expires_at')).toBe('2099-01-01T00:00:00.000Z')
})
it('multiple link predicates share a single top-level authority check', async () => {
  const kernel = new KernelRegistry(config({ and: [{ actorLinkedIn: 'people' }, { actorLinkedIn: 'teams' }] }))
  const scope = await live(kernel, await token())
  const read = compileRoot(kernel, scope, validateQuery(kernel, scope, query).query)
  const write = writeFilter(kernel, scope, 'jobs')
  for (const sql of [read.sql, write.sql]) {
    expect(sql.match(/\bEXISTS\s*\(/gi)).toHaveLength(3)
    expect(sql.match(/FROM memberships AS __actor_link_member/g)).toHaveLength(1)
    expect(sql.match(/FROM "people" AS __actor_link/g)).toHaveLength(1)
    expect(sql.match(/FROM "teams" AS __actor_link/g)).toHaveLength(1)
    expect(sql).toContain("strftime('%Y-%m-%dT%H:%M:%fZ','now')")
  }
})
it.each(nestedPolicies)('$name SQL keeps one link EXISTS and one authority check outside the relation', async ({ where }) => {
  const kernel = new KernelRegistry(relationConfig(where))
  const scope = await live(kernel, await token())
  const read = compileRoot(kernel, scope, validateQuery(kernel, scope, query).query)
  const write = writeFilter(kernel, scope, 'jobs')
  for (const sql of [read.sql, write.sql]) {
    expect(sql.match(/\bEXISTS\s*\(/gi)).toHaveLength(3) // Relation, link, authority.
    expect(sql.match(/FROM memberships AS __actor_link_member/g)).toHaveLength(1)
    expect(sql.match(/FROM "people" AS __actor_link/g)).toHaveLength(1)
    expect(sql.indexOf('FROM memberships AS __actor_link_member')).toBeLessThan(sql.indexOf('FROM "people" AS __actor_link'))
  }
})
