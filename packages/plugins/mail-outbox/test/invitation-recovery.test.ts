import { expect, it, vi } from 'vitest'
import { env } from 'cloudflare:workers'
import sample from '../../../core/test/fixtures/sample/config'
import { createApp } from '@workbasehq/core/app'
import { completeInvitationProfiles, json, request, runtime, setup } from '@workbasehq/test-support/helpers'

it('Resend recovers a timed-out invitation using a fresh intent', async () => {
  await setup(); await completeInvitationProfiles()
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  let finish!: () => void, started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const send = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; started() })).mockResolvedValue(undefined)
  const app = createApp(sample, { ...runtime(), EMAIL: { send }, EMAIL_FROM: 'noreply@example.test' })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const creation = Promise.resolve(request(app, '/orgs/org-a/invitations', 'POST', { email: 'recovery@example.test', role: 'viewer' }))
  try {
    await ready; await vi.advanceTimersByTimeAsync(60000)
    const response = await creation
    expect(response.status).toBe(201)
    const created = await json(response)
    expect(created.delivery).toMatchObject({ status: 'failed', attempts: 1, error: 'email_send_failed' })
    const before = await env.DB.prepare('SELECT delivery_outbox_id,token_hash FROM invitations WHERE id=?').bind(created.id).first<{ delivery_outbox_id: string; token_hash: string }>()
    const retried = await request(app, `/orgs/org-a/invitations/${created.id}/retry-delivery`, 'POST')
    expect(retried.status).toBe(200); expect(send).toHaveBeenCalledTimes(1)
    const resent = await request(app, `/orgs/org-a/invitations/${created.id}/resend`, 'POST', {})
    expect(resent.status).toBe(200); expect((await json(resent)).delivery.status).toBe('delivered')
    const after = await env.DB.prepare('SELECT delivery_outbox_id,token_hash FROM invitations WHERE id=?').bind(created.id).first<{ delivery_outbox_id: string; token_hash: string }>()
    expect(after!.delivery_outbox_id).not.toBe(before!.delivery_outbox_id)
    expect(after!.token_hash).not.toBe(before!.token_hash)
    expect(await env.DB.prepare('SELECT last_error FROM email_outbox WHERE id=?').bind(before!.delivery_outbox_id).first('last_error')).toBe('email_send_timeout')
    expect(send).toHaveBeenCalledTimes(2)
  } finally { finish(); await creation.catch(() => {}); log.mockRestore(); vi.useRealTimers() }
})
