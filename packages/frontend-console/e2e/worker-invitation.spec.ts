import { test, expect } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import en from '../src/locales/en.json' with { type: 'json' }
import cs from '../src/locales/cs.json' with { type: 'json' }
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
  const copy = () => request.post(`/orgs/org-a/invitations/${invitation.invitation_id}/copy-link`, { headers, data: {} })
  const firstCopy = await copy()
  expect(firstCopy.status()).toBe(200)
  const copied = (await firstCopy.json()).accept_url
  const retried = await request.post(`/orgs/org-a/invitations/${invitation.invitation_id}/retry-delivery`, { headers, data: {} })
  expect(retried.status()).toBe(200)
  expect((await retried.json()).delivery).toMatchObject({ status: 'delivered', attempts: 2 })
  const transport = await request.get('/__test/mail', { headers: { Authorization: 'Bearer worker-local-control' } })
  const { messages } = await transport.json()
  expect(messages).toHaveLength(1)
  expect(messages[0].to).toBe('recipient@example.test')
  const delivered = messages[0].text.match(/https?:\/\/[^\s]+\/invitations\/accept\?token=[a-f0-9]+\.[a-f0-9]+/)?.[0]
  expect(Boolean(delivered), 'transport contains the delivered-email credential').toBe(true)
  expect(new Set(messages[0].text.match(/https?:\/\/[^\s]+/g))).toEqual(new Set([delivered]))
  expect(messages[0].text).not.toContain(copied)
  expect(messages[0].text).not.toContain(invitation.accept_url)
  expect(new URL(delivered).searchParams.get('token')!.split('.')[0]).not.toBe(new URL(copied).searchParams.get('token'))
  expect((await copy()).status()).toBe(200)
  const again = await request.post(`/orgs/org-a/invitations/${invitation.invitation_id}/retry-delivery`, { headers, data: {} })
  expect((await again.json()).delivery).toMatchObject({ status: 'delivered', attempts: 2 })
  const afterRetry = await request.get('/__test/mail', { headers: { Authorization: 'Bearer worker-local-control' } })
  expect((await afterRetry.json()).messages).toHaveLength(1)
  // No storage state, session cookie, Authorization header or inviter context.
  const recipient = await browser.newContext({ baseURL: origin })
  try {
    expect(await recipient.cookies()).toEqual([])
    const page = await recipient.newPage()
    await page.goto(delivered)
    await expect(page.getByRole('button', { name: 'Accept invitation', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Accept invitation', exact: true })).toBeVisible()
    await expect(page.getByText('Invitation workspace', { exact: true })).toBeVisible()
    await expect(page.getByText('admin', { exact: true })).toBeVisible()
    expect(await recipient.cookies()).toEqual([])
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

for (const language of ['en', 'cs'] as const) test(`${language} copied invitation signs in first and joins only after explicit acceptance`, async ({ browser, request }) => {
  const copy = language === 'en' ? en : cs
  const email = `copied-${language}@example.test`
  const headers = { Authorization: 'Bearer worker-admin-session', 'X-Organization-Id': 'org-a' }
  const created = await request.post('/orgs/org-a/invitations', { headers, data: { email, role: 'staff' } })
  expect(created.status()).toBe(201)
  const invitation = await created.json()
  const copied = await request.post(`/orgs/org-a/invitations/${invitation.id}/copy-link`, { headers, data: {} })
  expect(copied.status()).toBe(200)
  const copiedUrl = (await copied.json()).accept_url
  const recipient = await browser.newContext({ baseURL: origin, viewport: { width: 1440, height: 900 } })
  try {
    await recipient.addInitScript(locale => localStorage.setItem('console-language', locale), language)
    expect(await recipient.cookies()).toEqual([])
    const page = await recipient.newPage()
    const accepts: string[] = []
    page.on('request', incoming => {
      const path = new URL(incoming.url()).pathname
      if (incoming.method() === 'POST' && /^\/invitations\/(?:[^/]+\/)?accept$/.test(path)) accepts.push(path)
    })
    const screenshot = async (step: string) => {
      if (!process.env.WORKER_INVITATION_SCREENSHOTS) return
      mkdirSync(process.env.WORKER_INVITATION_SCREENSHOTS, { recursive: true })
      expect(new URL(page.url()).search).toBe('')
      await page.screenshot({ path: join(process.env.WORKER_INVITATION_SCREENSHOTS, `${language}-${step}.png`), fullPage: true })
    }
    const preflight = page.waitForResponse(response => new URL(response.url()).pathname === '/invitations/preflight')
    await page.goto(copiedUrl)
    const publicResponse = await preflight
    expect(publicResponse.status()).toBe(200)
    expect(await publicResponse.json()).toEqual({ id: invitation.id, account_match: null })
    await expect(page.getByRole('button', { name: copy.p10SignInToAccept, exact: true })).toBeVisible()
    await expect(page.getByText(copy.p10CopiedSignInDescription, { exact: true })).toBeVisible()
    await expect(page).toHaveURL(`${origin}/invitation`)
    await expect(page.getByRole('heading', { name: language === 'en' ? 'Invitation to Public instance' : 'Pozvánka do Public instance', exact: true })).toBeVisible()
    await expect(page.getByText('Invitation workspace', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: copy.p10Decline, exact: true })).toHaveCount(0)
    await screenshot('anonymous')
    await page.getByRole('button', { name: copy.p10SignInToAccept, exact: true }).click()
    await expect(page).toHaveURL(`${origin}/sign-in?returnTo=${encodeURIComponent(`/invitation?id=${invitation.id}`)}`)
    expect(accepts).toEqual([])
    await page.getByLabel(copy.email, { exact: true }).fill(email)
    const signIn = page.waitForResponse(response => new URL(response.url()).pathname === '/auth/sign-in/magic-link' && response.request().method() === 'POST')
    await page.getByRole('button', { name: copy.sendLink, exact: true }).click()
    expect((await signIn).status()).toBe(200)
    const mailbox = await request.get('/__test/mail', { headers: { Authorization: 'Bearer worker-local-control' } })
    const { messages } = await mailbox.json()
    const message = messages.filter((value: { to: string; text: string }) => value.to === email && value.text.includes('/auth/magic-link/verify')).at(-1)
    const loginUrl = message?.text.match(/https?:\/\/[^\s]+/)?.[0]
    expect(Boolean(loginUrl), 'synthetic mailbox contains a magic link').toBe(true)
    const preview = page.waitForResponse(response => new URL(response.url()).pathname === `/invitations/${invitation.id}/preview`)
    await page.goto(loginUrl)
    await expect(page.getByRole('heading', { name: copy.profileSetupTitle, exact: true })).toBeVisible()
    expect(accepts).toEqual([])
    await page.getByLabel(copy.firstName, { exact: true }).fill('Copied')
    await page.getByLabel(copy.lastName, { exact: true }).fill('Synthetic')
    await page.getByRole('button', { name: copy.profileContinue, exact: true }).click()
    const recipientResponse = await preview
    expect(recipientResponse.status()).toBe(200)
    expect(await recipientResponse.json()).toMatchObject({ organization: { id: 'org-a', name: 'Invitation workspace' }, inviter: { display_name: 'admin' }, role: 'staff', account_match: true })
    await expect(page.getByRole('button', { name: copy.acceptInvitation, exact: true })).toBeVisible()
    await expect(page).toHaveURL(`${origin}/invitation`)
    expect(accepts).toEqual([])
    // Chromium honors secure loopback cookies; the separate API client does not.
    const memberships = () => page.evaluate(async () => {
      const response = await fetch('/me', { credentials: 'same-origin' })
      if (!response.ok) throw new Error(`Membership read failed: ${response.status}`)
      return (await response.json()).memberships
    })
    expect(await memberships()).toEqual([])
    await expect(page.getByText('Invitation workspace', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: copy.p10Decline, exact: true })).toBeVisible()
    await screenshot('authenticated')
    const acceptance = page.waitForResponse(response => new URL(response.url()).pathname === `/invitations/${invitation.id}/accept` && response.request().method() === 'POST')
    await page.getByRole('button', { name: copy.acceptInvitation, exact: true }).click()
    expect((await acceptance).status()).toBe(201)
    await expect(page.getByRole('heading', { name: copy.p10JoinedTitle, exact: true })).toBeVisible()
    expect(accepts).toEqual([`/invitations/${invitation.id}/accept`])
    expect(await memberships()).toEqual([expect.objectContaining({ organization_id: 'org-a', role: 'staff' })])
    await screenshot('joined')
  } finally { await recipient.close() }
})

for (const language of ['en', 'cs'] as const) test(`${language} copied invitation with a different verified account exposes only recovery`, async ({ browser, request }) => {
  const copy = language === 'en' ? en : cs
  const headers = { Authorization: 'Bearer worker-admin-session', 'X-Organization-Id': 'org-a' }
  const created = await request.post('/orgs/org-a/invitations', { headers, data: { email: `other-${language}@example.test`, role: 'staff' } })
  expect(created.status()).toBe(201)
  const invitation = await created.json()
  const copied = await request.post(`/orgs/org-a/invitations/${invitation.id}/copy-link`, { headers, data: {} })
  expect(copied.status()).toBe(200)
  const copiedUrl = (await copied.json()).accept_url
  const other = await browser.newContext({ baseURL: origin, extraHTTPHeaders: { Authorization: 'Bearer worker-admin-session' } })
  try {
    await other.addInitScript(locale => localStorage.setItem('console-language', locale), language)
    const page = await other.newPage()
    let mutations = 0
    page.on('request', incoming => { if (incoming.method() === 'POST' && /\/invitations\/(?:[^/]+\/)?(?:accept|decline|resolve)$/.test(new URL(incoming.url()).pathname)) mutations++ })
    const preflight = page.waitForResponse(response => new URL(response.url()).pathname === '/invitations/preflight')
    await page.goto(copiedUrl)
    const response = await preflight
    expect(response.status()).toBe(200)
    expect(await response.json()).toEqual({ id: invitation.id, account_match: false })
    await expect(page.getByText(copy.p10WrongAccountTitle, { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: language === 'en' ? 'Invitation to Public instance' : 'Pozvánka do Public instance', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: copy.p10SwitchAccount, exact: true })).toBeVisible()
    await expect(page.getByText('Invitation workspace', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: copy.acceptInvitation, exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: copy.p10Decline, exact: true })).toHaveCount(0)
    expect(mutations).toBe(0)
    if (process.env.WORKER_INVITATION_SCREENSHOTS) {
      mkdirSync(process.env.WORKER_INVITATION_SCREENSHOTS, { recursive: true })
      expect(new URL(page.url()).search).toBe('')
      await page.screenshot({ path: join(process.env.WORKER_INVITATION_SCREENSHOTS, `${language}-other-account.png`), fullPage: true })
    }
  } finally { await other.close() }
})
