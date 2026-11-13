declare const document: { documentElement: { scrollWidth: number }; activeElement: unknown; dispatchEvent(event: Event): void }
declare const window: { innerWidth: number }
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createServer, type ViteDevServer } from 'vite'
import { unstable_dev, type Unstable_DevWorker } from 'wrangler'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import type { ClientRequestInit } from '../../src/client'
import { afterAll, beforeAll, expect, test } from 'vitest'
let vite: ViteDevServer, worker: Unstable_DevWorker, browser: Browser, origin: string, scratch: string
const control = { 'X-Test-Control': 'synthetic-ui-control' }
beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'workbase-live-ui-'))
  const config = join(scratch, 'wrangler.json')
  writeFileSync(config, JSON.stringify({ name: 'synthetic-live-ui', main: resolve(import.meta.dirname, 'worker.ts'), compatibility_date: '2026-08-01', compatibility_flags: ['nodejs_compat'], d1_databases: [{ binding: 'DB', database_name: 'live-ui', database_id: '00000000-0000-0000-0000-000000000012' }], kv_namespaces: [{ binding: 'AUDIT_KV', id: '00000000000000000000000000000000' }] }))
  worker = await unstable_dev(resolve(import.meta.dirname, 'worker.ts'), { config, local: true, ip: '127.0.0.1', port: 0, inspectorPort: 0, persist: false, logLevel: 'error', experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false } })
  const target = `http://${worker.address}:${worker.port}`
  vite = await createServer({ root: import.meta.dirname, configFile: false, server: { host: '127.0.0.1', port: 0, headers: { 'Referrer-Policy': 'no-referrer' }, proxy: Object.fromEntries(['/api', '/query', '/me', '/o/', '/orgs', '/invitations', '/auth', '/__test'].map(path => [path, { target, changeOrigin: true, bypass: (request: { url?: string }) => request.url?.startsWith('/auth/complete') ? '/index.html' : undefined }])) } })
  await vite.listen(); const address = vite.httpServer!.address() as { port: number }; origin = 'http://127.0.0.1:' + address.port
  // The test Worker consumes its trusted loopback origin from a control request.
  const seeded = await fetch(target + '/__test/seed', { headers: { ...control, 'X-Test-Origin': origin } })
  expect(seeded.status, await seeded.text()).toBe(200)
  browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {})
}, 60000)
afterAll(async () => { await browser?.close(); await vite?.close(); await worker?.stop(); if (scratch) rmSync(scratch, { recursive: true, force: true }) })
let sessionIP = 0
async function session(role: string): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: origin, viewport: { width: 390, height: 844 }, hasTouch: true, extraHTTPHeaders: { 'cf-connecting-ip': '192.0.2.' + (++sessionIP) } })
  const sent = await context.request.post('/auth/sign-in/magic-link', { headers: { Origin: origin }, data: { email: role + '@example.test', callbackURL: '/me' } })
  expect(sent.status(), await sent.text()).toBe(200)
  const mail = await context.request.get('/__test/mail?email=' + role + '@example.test', { headers: control })
  const { link } = await mail.json()
  expect(link).toBeTruthy(); const signed = await context.request.get(link, { maxRedirects: 0 }); expect(signed.status(), await signed.text()).toBe(302)
  return context
}
async function fits(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true) }
test('390px keyboard and tap list → new → detail → edit → back; real invite/link/unlink', async () => {
  const context = await session('admin'), page = await context.newPage()
  page.setDefaultTimeout(10000); page.on('pageerror', error => console.error('Browser page error:', error.message))
  try {
    await page.goto('/workers')
    await page.getByRole('button', { name: 'Create', exact: true }).waitFor(); await fits(page)
    const nav = page.getByRole('button', { name: 'Navigation', exact: true })
    expect(await nav.getAttribute('aria-expanded')).toBe('false'); await nav.tap()
    await page.getByRole('link', { name: 'People', exact: true }).waitFor();
    await page.getByRole('link', { name: 'People', exact: true }).focus(); await page.keyboard.press('Escape')
    expect(await nav.getAttribute('aria-expanded')).toBe('false'); expect(await nav.evaluate(element => element === document.activeElement)).toBe(true)
    await page.getByRole('button', { name: 'Create', exact: true }).focus(); await page.keyboard.press('Enter')
    await page.getByLabel('Name', { exact: true }).fill('Mobile person'); await fits(page)
    await page.getByRole('button', { name: 'Save', exact: true }).tap()
    await page.getByRole('heading', { name: 'Detail', exact: true }).waitFor(); await fits(page)
    await page.getByRole('button', { name: 'Edit', exact: true }).focus(); await page.keyboard.press('Enter')
    await page.getByLabel('Name', { exact: true }).waitFor(); await fits(page); await page.getByRole('button', { name: 'Back', exact: true }).tap()
    await page.getByRole('heading', { name: 'Detail', exact: true }).waitFor()
    await page.getByLabel('Email', { exact: true }).fill('outbox@example.test'); await page.getByRole('button', { name: 'Invite', exact: true }).tap()
    const outbox = page.getByLabel('Outbox link', { exact: true }); await outbox.waitFor(); expect(await outbox.inputValue()).toContain('/invitations/accept')
    await page.reload(); await page.getByText('Invited', { exact: true }).waitFor(); expect(await page.getByLabel('Outbox link', { exact: true }).count()).toBe(0)
    await page.getByRole('button', { name: 'Cancel invitation', exact: true }).tap(); await page.getByText('No account', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Link account', exact: true }).tap(); await page.getByLabel('Account', { exact: true }).selectOption('candidate'); await page.getByRole('button', { name: 'Link account', exact: true }).tap()
    await page.getByText('Linked', { exact: true }).waitFor(); await page.getByRole('button', { name: 'Unlink account', exact: true }).tap(); await page.getByText('No account', { exact: true }).waitFor(); await fits(page)
  } catch (error) { console.error('Browser body:', await page.locator('body').innerText()); throw error }
  finally { await context.close() }
}, 60000)
test('staff direct URLs/forged writes, capability failure and actual DB demotion purge', async () => {
  const staff = await session('staff'), page = await staff.newPage(), calls: string[] = []
  page.setDefaultTimeout(10000); page.on('pageerror', error => console.error('Browser page error:', error.message))
  page.on('request', request => { if (/\/(api|query)(\/|$)/.test(new URL(request.url()).pathname)) calls.push(request.url()) })
  try {
    for (const path of ['/workers/new', '/workers/own/edit']) { calls.length = 0; await page.goto(path); await page.getByText('Access denied', { exact: true }).waitFor(); expect(calls).toHaveLength(0) }
    await page.goto('/workers/other'); await page.getByText('Not found', { exact: true }).waitFor(); expect(await page.getByText('Foreign bytes', { exact: true }).count()).toBe(0)
    for (const [path, method, data] of [['/api/worker', 'POST', { name: 'Forged' }], ['/api/worker/own', 'PATCH', { name: 'Forged' }], ...['invite', 'cancel_invite', 'link_account', 'unlink_account'].map(name => ['/api/worker/own/actions/' + name, 'POST', name === 'invite' ? { email: 'x@example.test' } : name === 'link_account' ? { user_id: 'admin' } : {}])] as [string, string, object][]) {
      const status = await page.evaluate(async ({ path, method, data }) => (await fetch(path, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'If-Match': '1' }, body: JSON.stringify(data) } as ClientRequestInit)).status, { path, method, data }); expect([403, 404]).toContain(status)
    }
    await page.goto('/workers/own'); await page.getByText('Staff self', { exact: true }).waitFor()
    expect(await page.getByRole('button', { name: 'Edit', exact: true }).count()).toBe(0)
    expect(await page.getByRole('region', { name: 'Application access' }).count()).toBe(0)
    await page.route('**/capabilities', route => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }))
    calls.length = 0; await page.goto('/workers'); await page.getByRole('alert').filter({ hasText: 'Unable to load session' }).waitFor(); expect(calls).toHaveLength(0); expect(await page.getByRole('navigation').count()).toBe(0)
  } catch (error) { console.error('Staff browser body:', await page.locator('body').innerText()); throw error }
  finally { await staff.close() }
  for (const trigger of ['save', 'visibility']) {
    const admin = await session('admin'), tab = await admin.newPage()
    try {
      await admin.request.get('/__test/promote', { headers: control }); await tab.goto('/workers'); await tab.getByRole('button', { name: 'Foreign bytes', exact: true }).waitFor()
      if (trigger === 'save') { await tab.getByRole('button', { name: 'Foreign bytes', exact: true }).click(); await tab.getByRole('button', { name: 'Edit', exact: true }).click(); await tab.getByLabel('Name', { exact: true }).fill('Stale') }
      await admin.request.get('/__test/demote', { headers: control })
      if (trigger === 'save') { await tab.getByRole('button', { name: 'Save', exact: true }).click(); await tab.getByText('Access denied', { exact: true }).waitFor(); await tab.goBack(); await tab.goBack() }
      else await tab.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')) })
      await tab.getByText('No records', { exact: true }).waitFor()
      expect(await tab.getByRole('button', { name: 'Create', exact: true }).count()).toBe(0); expect(await tab.getByText('Foreign bytes', { exact: true }).count()).toBe(0)
    } finally { await admin.request.get('/__test/promote', { headers: control }); await admin.close() }
  }
}, 60000)

// APIRequestContext does not send Secure cookies over HTTP loopback; the browser does.
async function cookieHeaders(context: BrowserContext) {
  return { 'Sec-Fetch-Site': 'same-origin', Cookie: (await context.cookies()).map(cookie => cookie.name + '=' + cookie.value).join('; '), Origin: origin }
}
async function invite(context: BrowserContext, email: string) {
  const row = await context.request.post('/api/worker', { headers: { ...await cookieHeaders(context), 'X-Organization-Id': 'org-a', 'Idempotency-Key': crypto.randomUUID() }, data: { name: 'Auth recipient' } })
  expect(row.status(), await row.text()).toBe(201)
  const { id } = await row.json()
  const sent = await context.request.post('/api/worker/' + id + '/actions/invite', { headers: { ...await cookieHeaders(context), 'X-Organization-Id': 'org-a' }, data: { email } })
  expect(sent.status()).toBe(201)
  return { ...(await sent.json()), workerId: id } as { invitation_id: string; accept_url: string; workerId: string }
}
test('auth shell: wrong accounts cannot bind; sign-out, inline magic link, profile, accept and replay on real D1', async () => {
  const admin = await session('admin'), b = await session('candidate')
  const email = 'auth-recipient@example.test', invited = await invite(admin, email)
  const token = new URL(invited.accept_url).searchParams.get('token')!
  try {
    for (const account of [b, admin]) {
      const page = await account.newPage()
      await page.goto('/invitation?token=' + token)
      await page.getByText('This invitation belongs to another account', { exact: true }).waitFor()
      expect(await page.locator('body').innerText()).not.toContain(email)
      const denied = await account.request.post('/invitations/resolve', { headers: await cookieHeaders(account), data: { token } })
      expect(denied.status()).toBe(403)
      const state = await admin.request.get('/__test/invitation?id=' + invited.invitation_id, { headers: control })
      expect(await state.json()).toMatchObject({ bound_user_id: null, accepted_at: null, members: 0 })
      await page.getByRole('button', { name: 'Sign out', exact: true }).first().click()
      await page.waitForURL('**/sign-in'); expect((await account.request.get('/me')).status()).toBe(401)
      await page.close()
    }
    // Continue as A in the same browser that previously belonged to B.
    const page = await b.newPage(), calls: { url: string; body: string | null; referer: string | undefined }[] = [], output: string[] = []
    page.on('console', message => output.push(message.text()))
    page.on('request', request => { calls.push({ url: request.url(), body: request.postData(), referer: request.headers().referer }) })
    await page.goto('/invitation?token=' + token); await page.getByRole('button', { name: 'Continue', exact: true }).waitFor()
    expect(new URL(page.url()).search).toBe('')
    // An initial document link necessarily contains the token; all subsequent traffic is clean.
    expect(calls.filter(call => call.url.includes(token))).toHaveLength(1)
    await page.getByRole('button', { name: 'Continue', exact: true }).click(); await page.getByLabel('Email', { exact: true }).fill(email)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await page.getByText('Check your mail', { exact: true }).waitFor()
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(token)
    expect(output.join('\n')).not.toContain(token); expect(calls.every(call => !call.referer?.includes(token))).toBe(true)
    const mail = await b.request.get('/__test/mail?email=' + email, { headers: control }), { link } = await mail.json()
    await page.goto(link); await page.getByLabel('First name', { exact: true }).fill('Recipient'); await page.getByLabel('Last name', { exact: true }).fill('Example')
    const path = new URL(page.url()).pathname; let patches = 0
    page.on('request', request => { if (new URL(request.url()).pathname === '/me/profile' && request.method() === 'PATCH') patches++ })
    await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('button', { name: 'Accept invitation', exact: true }).waitFor()
    expect(patches).toBe(1); expect(new URL(page.url()).pathname).toBe(path)
    await page.getByRole('button', { name: 'Accept invitation', exact: true }).click(); await page.waitForURL(origin + '/')
    expect(await page.evaluate(() => localStorage.getItem('workbase.org'))).toBe('org-a')
    const replay = await b.request.post('/invitations/' + invited.invitation_id + '/accept', { headers: await cookieHeaders(b), data: {} })
    expect(replay.status()).toBe(200); expect(await replay.json()).toMatchObject({ replayed: true })
    const csrf = await b.request.post('/auth/logout', { headers: { ...await cookieHeaders(b), Origin: 'https://cross-site.example', 'Sec-Fetch-Site': 'cross-site' }, form: {} })
    expect(csrf.status()).toBe(403); expect((await b.request.get('/me', { headers: await cookieHeaders(b) })).status()).toBe(200)
    expect((await b.request.get('/auth/logout', { headers: await cookieHeaders(b) })).status()).toBe(404)
    expect(calls.filter(call => call.url.includes(token))).toHaveLength(1)
    await page.close()
  } finally { await admin.close(); await b.close() }
}, 60000)

test('expired/revoked invitation terminal screens on real D1', async () => {
  const admin = await session('admin')
  try {
    for (const state of ['expired', 'revoked']) {
      const invited = await invite(admin, state + '-auth@example.test')
      const changed = await admin.request.post('/__test/invitation?id=' + invited.invitation_id + '&state=' + state, { headers: control }); expect(changed.status()).toBe(200)
      const page = await admin.newPage(); await page.goto('/invitation?token=' + new URL(invited.accept_url).searchParams.get('token'))
      // Mismatch wins over metadata for an authenticated different account.
      await page.getByText('This invitation belongs to another account', { exact: true }).waitFor(); await page.close()
      const anonymous = await browser.newContext({ baseURL: origin }), tab = await anonymous.newPage()
      await tab.goto('/invitation?token=' + new URL(invited.accept_url).searchParams.get('token'))
      await tab.getByText(state === 'expired' ? 'Invitation expired' : 'Invitation revoked', { exact: true }).waitFor(); expect(await tab.getByRole('button', { name: 'Continue' }).count()).toBe(0)
      await anonymous.close()
    }
  } finally { await admin.close() }
}, 60000)
