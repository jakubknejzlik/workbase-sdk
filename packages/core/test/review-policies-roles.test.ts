// Ported from the independent FIX FIRST review (2026-10-24).
import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { setup } from './fixtures/policy-graph/setup'
import { request, json } from '@workbasehq/test-support/helpers'
import { createCommandRegistry } from '../src/commands'
import { atomic, operation } from './review-policies-helpers'
let app: Awaited<ReturnType<typeof setup>>
beforeEach(async () => { app = await setup(); })
it('review: generic REST role assignment to a colleague must use owner member path', async () => {
    const r = await request(app, '/api/users/reviewer-colleague', 'PATCH', { role: 'administrator', version: 1 }, 'reviewer')
    expect({ status: r.status, body: await json(r) }).toMatchObject({ status: 403, body: { error: 'field_forbidden' } })
})
it('review: generic command cannot assign another member administrator', async () => {
    const op = operation('UPDATE memberships SET role=? WHERE user_id=? AND organization_id=?', ['administrator', 'reviewer-colleague', 'org-a'])
    await expect(atomic(op)).rejects.toMatchObject({ status: 403 })
})
it('proof: a reviewer command cannot promote a colleague live membership or unlock records', async () => {
    const op = operation('UPDATE memberships SET role=? WHERE user_id=? AND organization_id=?', ['administrator', 'reviewer-colleague', 'org-a'])
    app = await setup({ commands: createCommandRegistry([op]) })
    const ask = () => request(app, '/query', 'POST', { entity: 'records', select: ['id'], limit: 10 }, 'reviewer-colleague')
    expect((await json(await ask())).data).toHaveLength(2)
    expect((await request(app, '/commands/users/change', 'POST', {}, 'reviewer')).status).toBe(403)
    expect(await env.DB.prepare("SELECT role FROM memberships WHERE user_id='reviewer-colleague'").first('role')).toBe('reviewer')
    expect((await json(await ask())).data).toHaveLength(2)
})
