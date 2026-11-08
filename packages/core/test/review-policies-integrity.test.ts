// Ported from the independent FIX FIRST review (2026-10-24).
import { createWorkflowRegistry } from '../src/workflow-runtime'
import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { z } from 'zod'
import { setup, runtime, policyGraph } from './fixtures/policy-graph/setup'
import { request, json } from '@workbasehq/test-support/helpers'
import { KernelRegistry } from '../src/kernel/registry'
import { executeAtomic } from '../src/execution/atomic'
import { coreExecutionContext } from '../src/execution/context'
import { D1AtomicReader, D1AtomicStore } from '../src/execution/d1'
import { createCommandRegistry } from '../src/commands'
import type { AtomicOperation } from '../src/execution/types'
import { atomic, live, operation } from './review-policies-helpers'
let app: Awaited<ReturnType<typeof setup>>
beforeEach(async () => { app = await setup(); })
const selfChange: AtomicOperation = { name: 'users/change', permission: { entity: 'users', operation: 'update' }, input: z.strictObject({}), plan: () => ({ rules: [{ name: 'change_team', statements: [{ sql: 'UPDATE users SET"team_id"=? WHERE id=?', bindings: ['team-b', 'reviewer'], expectRows: 1 }] }], result: { status: 200, body: { ok: true } }, event: { entity: 'users', entityId: 'reviewer', operation: 'review.change' } }) }
async function cookie() {
    const sent = await app.request('http://localhost/auth/sign-in/magic-link', { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'reviewer@example.test', callbackURL: '/admin' }) })
    expect(sent.status).toBe(200)
    const link = (await env.DB.prepare("SELECT body FROM email_outbox WHERE recipient='reviewer@example.test' ORDER BY rowid DESC LIMIT 1").first<string>('body'))!
    const signed = await app.request(link)
    expect(signed.status).toBe(302)
    return signed.headers.getSetCookie().find(c => c.startsWith('__Host-workbase.session='))!.split(';')[0]
}
it.each(['"team_id"', '[team_id]', '`team_id`'])('review: adjacent SET %s must protect actor dependency', async (field) => {
    const op = operation(`UPDATE users SET${field}=? WHERE id=?`, ['team-b', 'reviewer'])
    await expect(atomic(op)).rejects.toMatchObject({ status: 403, code: 'field_forbidden' })
    expect(await env.DB.prepare("SELECT team_id FROM users WHERE id='reviewer'").first('team_id')).toBe('team-a')
})
it('proof: quoted SET command cannot change live actor team or expose a hidden record', async () => {
    const op = operation('UPDATE users SET"team_id"=? WHERE id=?', ['team-b', 'reviewer'])
    app = await setup({ commands: createCommandRegistry([op]) })
    const ask = () => request(app, '/query', 'POST', { entity: 'records', select: ['id'], limit: 10 }, 'reviewer')
    expect((await json(await ask())).data.map((r: any) => r.id)).toEqual(['record-colleague', 'record-own'])
    expect((await request(app, '/commands/users/change', 'POST', {}, 'reviewer')).status).toBe(403)
    expect(await env.DB.prepare("SELECT team_id FROM users WHERE id='reviewer'").first('team_id')).toBe('team-a')
    expect((await json(await ask())).data.map((r: any) => r.id)).toEqual(['record-colleague', 'record-own'])
})
it('review: cloned atomic plan protects adjacent quoted actor assignment', async () => {
    const op = operation('UPDATE users SET"team_id"=? WHERE id=?', ['team-b', 'reviewer'])
    const kernel = new KernelRegistry(policyGraph, { commands: createCommandRegistry([op]) })
    const scope = await live('reviewer', kernel.config)
    const store = { run: (plan: any) => new D1AtomicStore(env.DB).run(structuredClone(plan)) }
    await expect(executeAtomic(op, {}, coreExecutionContext(kernel.config, scope, store, new D1AtomicReader(env.DB)))).rejects.toMatchObject({ status: 403, code: 'field_forbidden' })
})
it('review: adjacent SET cannot change the actor live membership role', async () => {
    const op = operation('UPDATE memberships SET"role"=? WHERE user_id=? AND organization_id=?', ['administrator', 'reviewer', 'org-a'])
    await expect(atomic(op)).rejects.toMatchObject({ status: 403, code: 'field_forbidden' })
})
it('proof: quoted SET command cannot promote own live membership to administrator', async () => {
    const op = operation('UPDATE memberships SET"role"=? WHERE user_id=? AND organization_id=?', ['administrator', 'reviewer', 'org-a'])
    app = await setup({ commands: createCommandRegistry([op]) })
    expect((await request(app, '/commands/users/change', 'POST', {}, 'reviewer')).status).toBe(403)
    expect(await env.DB.prepare("SELECT role FROM memberships WHERE user_id='reviewer'").first('role')).toBe('reviewer')
    const r = await request(app, '/query', 'POST', { entity: 'records', select: ['id'], limit: 10 }, 'reviewer')
    expect(r.status).toBe(200)
    expect((await json(r)).data).toHaveLength(2)
})
it('review: admin UI dispatch protects the actor field with valid CSRF and real session', async () => {
    app = await setup({ commands: createCommandRegistry([selfChange]) })
    const auth = await cookie()
    const path = '/admin/o/org-a/commands/users/change'
    const page = await app.request('http://localhost' + path, { headers: { Cookie: auth } })
    expect(page.status).toBe(200)
    const html = await page.text()
    const csrf = /name="_csrf" value="([^"]+)"/.exec(html)![1]
    const key = /name="idempotencyKey" value="([^"]+)"/.exec(html)![1]
    const sent = await app.request('http://localhost' + path, { method: 'POST', headers: { Cookie: auth, Origin: 'http://localhost', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, idempotencyKey: key }) })
    expect(sent.status).toBe(403)
    expect(await env.DB.prepare("SELECT team_id FROM users WHERE id='reviewer'").first('team_id')).toBe('team-a')
})
it('review: workflow step protects the actor dependency', async () => {
    const workflows = createWorkflowRegistry([{ name: 'users/reassign', version: '1', input: z.strictObject({}), steps: [{ id: 'change', operation: selfChange, sideEffect: false, policy: { maxAttempts: 1, backoffMs: 0, timeoutMs: 1000, deadlineMs: 10000 }, run: ({ context }) => executeAtomic(selfChange, {}, context) }] }])
    app = await setup({ commands: createCommandRegistry([selfChange]), workflows })
    const start = await request(app, '/workflows/users/reassign', 'POST', { idempotencyKey: 'review-workflow' }, 'reviewer')
    expect(start.status).toBe(202)
    const tick = await request(app, '/internal/workflows/run', 'POST', {}, 'reviewer', 'org-a', { 'X-Internal-Token': runtime().INTERNAL_TOKEN })
    expect(tick.status).toBe(200)
    expect(await env.DB.prepare("SELECT team_id FROM users WHERE id='reviewer'").first('team_id')).toBe('team-a')
})
