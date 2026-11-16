import { test, expect } from '@playwright/test'
import setup, { origin } from './runtime/setup'
let stop: (() => Promise<void>) | undefined
test.beforeAll(async () => { stop = await setup({ worker: 'worker-invitation-worker.ts', seed: 'worker-invitation-seed.ts' }) })
test.afterAll(async () => { await stop?.() })

test('V3 worker invite retries failed transport and its delivered link reaches acceptance in a clean browser', async ({ browser, request }) => {
  const headers = { Authorization: 'Bearer worker-admin-session', 'X-Organization-Id': 'org-a' }
  const created = await request.post('/api/worker/one/actions/invite', { headers, data: { email: 'recipient@example.test' } })
  expect(created.status()).toBe(201)
  const invitation = await created.json()
  expect(invitation.delivery).toMatchObject({ status: 'failed', attempts: 1 })
  const retried = await request.post(`/orgs/org-a/invitations/${invitation.invitation_id}/retry-delivery`, { headers, data: {} })
  expect(retried.status()).toBe(200)
  expect((await retried.json()).delivery).toMatchObject({ status: 'delivered', attempts: 2 })
  const transport = await request.get('/__test/mail', { headers: { Authorization: 'Bearer worker-local-control' } })
  const { messages } = await transport.json()
  expect(messages).toHaveLength(1)
  expect(messages[0].to).toBe('recipient@example.test')
  const delivered = messages[0].text.match(/https?:\/\/[^\s]+\/invitations\/accept\?token=[a-f0-9]+\.[a-f0-9]+/)?.[0]
  expect(Boolean(delivered), 'transport contains the delivered-email credential').toBe(true)
  // No storage state, session cookie, Authorization header or inviter context.
  const recipient = await browser.newContext({ baseURL: origin })
  try {
    expect(await recipient.cookies()).toEqual([])
    const page = await recipient.newPage()
    await page.goto(delivered)
    await expect(page.getByRole('button', { name: 'Accept invitation', exact: true })).toBeVisible()
    await expect(page.getByText('Invitation workspace', { exact: true })).toBeVisible()
    const accepted = page.waitForResponse(response => response.url().endsWith('/invitations/accept') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Accept invitation', exact: true }).click()
    const response = await accepted
    expect(response.status()).toBe(200)
    // Mailbox proof establishes the recipient's session before membership is granted.
    expect((await recipient.cookies()).length).toBeGreaterThan(0)
    await expect(page.getByRole('button', { name: 'Open organization', exact: true })).toBeVisible()
    const row = await request.get('/api/worker/one', { headers })
    expect((await row.json()).user).toBe('recipient')
  } finally { await recipient.close() }
})
