import { env } from 'cloudflare:workers'
import { reset } from 'cloudflare:test'
import { policyGraph, roles } from './config'
import { initialSchema } from '../../../src/migrations/schema'
import { sha256 } from '../../../src/crypto'
import { KernelRegistry } from '../../../src/kernel/registry'
import { createApp } from '../../../src/app'
import type { RuntimeOptions } from '../../../src/types'

export const runtime = () => ({ DB: env.DB, AUDIT_KV: env.AUDIT_KV, INTERNAL_TOKEN: 'synthetic-policyGraph-internal', IDENTITY: { baseURL: 'http://localhost', secret: 'synthetic-policyGraph-secret-at-least-32', localPassword: true } })
export async function setup(options: RuntimeOptions = {}) {
  await reset()
  await env.DB.exec(initialSchema(policyGraph).replaceAll('\n', ' '))
  await new KernelRegistry(policyGraph, options).applyMigrations(env.DB)
  await env.DB.exec("INSERT INTO organizations VALUES ('org-a','Group'),('org-b','CANARY_ORG'); INSERT INTO teams (id,organization_id,name,created_at,updated_at) VALUES ('team-a','org-a','A','now','now'),('team-b','org-a','CANARY_TEAM','now','now'),('team-canary','org-b','CANARY_ORG','now','now');")
  for (const [id, role, team, assignable, org] of [
    ...[...roles, 'unknown'].map(role => [role, role, 'team-a', 0, 'org-a']),
    ['reviewer-colleague', 'reviewer', 'team-a', 0, 'org-a'], ['reviewer-other', 'reviewer', 'team-b', 0, 'org-a'],
    ['assignable', 'reviewer', 'team-b', 1, 'org-a'], ['operator-other', 'operator', 'team-b', 0, 'org-a'],
    ['CANARY_ACCOUNT', 'reviewer', 'team-canary', 0, 'org-b'],
  ] as (string | number)[][]) {
    await env.DB.prepare('INSERT INTO users (id,email,password_hash,salt,organization_id,name,role,team_id,assignable_to_job,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(id, `${id}@example.test`, 'x', 'x', org, id, role, team, assignable, 'now', 'now').run()
    await env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(id, id, `${id}@example.test`, 'now', 'now').run()
    await env.DB.prepare('INSERT INTO memberships VALUES (?,?,?)').bind(id, org, role).run()
    await env.DB.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(await sha256(`synthetic-${id}`), id, new Date(Date.now() + 86400000).toISOString()).run()
  }
  for (const [suffix, org, team, reviewer] of [['own', 'org-a', 'team-a', 'reviewer'], ['colleague', 'org-a', 'team-a', 'reviewer-colleague'], ['CANARY_ROW', 'org-a', 'team-b', 'reviewer-other'], ['CANARY_ORG', 'org-b', 'team-canary', 'CANARY_ACCOUNT']]) {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO records (id,organization_id,name,team_id,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind(`record-${suffix}`, org, suffix, team, 'now', 'now'),
      env.DB.prepare('INSERT INTO reports (id,organization_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').bind(`report-${suffix}`, org, suffix, 'now', 'now'),
    ])
    await env.DB.prepare('INSERT INTO jobs (id,organization_id,title,reviewer_user_id,record_id,report_id,internal_files_ids,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(`job-${suffix}`, org, suffix, reviewer, `record-${suffix}`, `report-${suffix}`, 'SECRET_FILES_CANARY', 'now', 'now').run()
  }
  for (const id of ['operator', 'operator-other']) await env.DB.prepare('INSERT INTO work_logs (id,organization_id,operator_user_id,minutes,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind(`log-${id}`, 'org-a', id, 30, 'now', 'now').run()
  return createApp(policyGraph, runtime(), options)
}
export { roles, policyGraph }
