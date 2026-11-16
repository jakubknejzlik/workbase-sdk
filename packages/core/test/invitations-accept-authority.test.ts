import { env } from 'cloudflare:workers'
import { reset } from 'cloudflare:test'
import { beforeEach, expect, it } from 'vitest'
import { bootstrap } from '@workbasehq/test-support/bootstrap'
import { completeInvitationProfiles } from '@workbasehq/test-support/helpers'
import { workerAccessFixture } from './fixtures/worker-access'
import { createApp } from '../src/app'
import { effectiveAuthorityLayers, effectiveSystemGrant } from '../src/access-evaluator'
import { canGrantRole, effectiveRolePrivileges } from '../src/organization-permissions'
import { sha256 } from '../src/crypto'
import { machineCredentials } from '@workbasehq/plugins/machine-credentials'

function config() {
  const selected = workerAccessFixture()
  return { ...selected, plugins: [...selected.plugins!, machineCredentials()], effectiveAccess: { ...selected.effectiveAccess!,
    entities: selected.effectiveAccess!.entities.map(rule => rule.role === 'staff' && rule.entity === 'invitations'
      ? { ...rule, decision: 'deny' as const } : rule),
  } }
}
const runtime = () => ({ DB: env.DB, AUDIT_KV: env.AUDIT_KV, INTERNAL_TOKEN: 'synthetic-access-internal',
  IDENTITY: { baseURL: 'http://localhost', secret: 'synthetic-access-secret-at-least-32', localPassword: true } })
let app: ReturnType<typeof createApp>
function request(path: string, actor = 'recipient', method = 'GET', body?: object) {
  return app.request(`http://localhost${path}`, { method,
    headers: { Authorization: `Bearer synthetic-${actor}`, 'X-Organization-Id': 'org-a', Origin: 'http://localhost', 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}
async function invite() {
  const response = await request('/orgs/org-a/invitations', 'admin', 'POST', { email: 'recipient@example.test', role: 'staff' })
  expect(response.status).toBe(201)
  const invitation = await response.json() as { id: string; accept_url: string }
  return { id: invitation.id, token: new URL(invitation.accept_url).searchParams.get('token')! }
}
async function expectUnclaimed(id: string) {
  expect(await env.DB.prepare('SELECT accepted_at FROM invitations WHERE id=?').bind(id).first('accepted_at')).toBeNull()
  expect(await env.DB.prepare("SELECT count(*) n FROM memberships WHERE user_id IN ('recipient','other')").first('n')).toBe(0)
}
beforeEach(async () => {
  await reset()
  const selected = config()
  await bootstrap(env.DB, selected)
  await env.DB.exec("INSERT INTO organizations VALUES ('org-a','A')")
  for (const id of ['admin', 'recipient', 'other']) {
    await env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)')
      .bind(id, id, `${id}@example.test`, 'now', 'now').run()
    await env.DB.prepare('INSERT INTO users (id,organization_id,email,name,role,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .bind(id, 'org-a', `${id}@example.test`, id, id === 'admin' ? 'admin' : 'staff', 'now', 'now').run()
    await env.DB.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(await sha256(`synthetic-${id}`), id, '2099-01-01T00:00:00.000Z').run()
    await env.DB.prepare("INSERT INTO identities VALUES (?,'local','local',?,'now')").bind(id, id).run()
  }
  await env.DB.exec("INSERT INTO memberships VALUES ('admin','org-a','admin')")
  await completeInvitationProfiles()
  app = createApp(selected, runtime())
})
it('explicit acceptance allow succeeds without invitation CRUD; staff management stays denied', async () => {
  const invitation = await invite()
  const response = await request('/invitations/accept', 'recipient', 'POST', { token: invitation.token })
  expect(response.status).toBe(201)
  expect(await response.json()).toMatchObject({ organization_id: 'org-a', role: 'staff' })
  expect(await env.DB.prepare('SELECT role FROM memberships WHERE user_id=?').bind('recipient').first('role')).toBe('staff')
  for (const path of ['/orgs/org-a/invitations', '/orgs/org-a/members', '/orgs/org-a/tokens']) {
    expect((await request(path)).status).toBe(403)
  }
  expect((await request('/orgs/org-a/invitations', 'recipient', 'POST', { email: 'blocked@example.test', role: 'staff' })).status).toBe(403)
  expect((await request(`/orgs/org-a/invitations/${invitation.id}`, 'recipient', 'DELETE')).status).toBe(403)
})
it.each(['deny', 'missing'] as const)('%s acceptance grant fails closed without membership changes', async decision => {
  const invitation = await invite()
  const selected = config()
  selected.effectiveAccess.system = selected.effectiveAccess.system.flatMap(rule => rule.role === 'staff' && rule.action === 'invitations.accept'
    ? decision === 'missing' ? [] : [{ ...rule, decision: 'deny' as const }] : [rule])
  app = createApp(selected, runtime())
  const response = await request('/invitations/accept', 'recipient', 'POST', { token: invitation.token })
  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ error: 'permission_denied' })
  await expectUnclaimed(invitation.id)
})
it('wrong account is rejected before invitation or membership changes', async () => {
  const invitation = await invite()
  const response = await request('/invitations/accept', 'other', 'POST', { token: invitation.token })
  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ error: 'invitation_not_for_this_account' })
  await expectUnclaimed(invitation.id)
})
it.each(['allow', 'deny', 'missing'] as const)('role-grant subset includes acceptance authority: issuer %s', async decision => {
  const selected = config()
  selected.effectiveAccess.system = selected.effectiveAccess.system.flatMap(rule => rule.role === 'admin' && rule.action === 'invitations.accept'
    ? decision === 'missing' ? [] : [{ ...rule, decision }] : [rule])
  expect(effectiveRolePrivileges(selected, 'staff').has('system:invitations.accept')).toBe(true)
  expect(canGrantRole(selected, 'admin', 'staff')).toBe(decision === 'allow')
  app = createApp(selected, runtime())
  const response = await request('/orgs/org-a/invitations', 'admin', 'POST', { email: 'recipient@example.test', role: 'staff' })
  expect(response.status).toBe(decision === 'allow' ? 201 : 403)
  if (decision !== 'allow') {
    expect(await response.json()).toEqual({ error: 'role_escalation' })
    expect(await env.DB.prepare('SELECT count(*) n FROM invitations').first('n')).toBe(0)
  }
})
it('only acceptance bypasses backing CRUD; deny wins and each authority layer must allow', () => {
  const policy = config().effectiveAccess
  // Even explicit system allows cannot bypass any other action\'s backing CRUD.
  const allowed = { ...policy, system: policy.system.map(rule => ({ ...rule, decision: 'allow' as const })) }
  for (const rule of allowed.system.filter(rule => rule.role === 'staff')) {
    expect(effectiveSystemGrant(allowed, ['staff'], rule.action), rule.action).toBe(rule.action === 'invitations.accept')
  }
  expect(effectiveSystemGrant(policy, ['unknown'], 'invitations.accept')).toBe(false)
  const denied = { ...policy, system: [...policy.system, { ...policy.system.find(rule => rule.role === 'admin' && rule.action === 'invitations.accept')!, decision: 'deny' as const }] }
  expect(effectiveSystemGrant(denied, ['admin', 'staff'], 'invitations.accept')).toBe(false)
  expect(effectiveAuthorityLayers(denied, [['staff'], ['admin']]).permits({ system: 'invitations.accept' })).toBe(false)
  expect(effectiveAuthorityLayers(policy, [['staff'], ['admin']]).permits({ system: 'invitations.accept' })).toBe(true)
})
