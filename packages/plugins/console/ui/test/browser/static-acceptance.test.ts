declare const document: { body: { textContent: string | null; innerText: string } }
declare const window: { addEventListener(type: string, listener: (event: { persisted: boolean }) => void): void; recordRestore(value: Restore): void }
declare const location: { pathname: string }
type Restore = { persisted: boolean; path: string; body: string; text: string }
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { build, preview, type PreviewServer } from 'vite'
import { unstable_dev, type Unstable_DevWorker } from 'wrangler'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { afterAll, beforeAll, expect, test } from 'vitest'
const forbiddenRequests: string[] = []
let vite: PreviewServer, worker: Unstable_DevWorker, browser: Browser, origin: string, scratch: string
const control = { 'X-Test-Control': 'synthetic-ui-control' }
beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'workbase-live-ui-'))
  const config = join(scratch, 'wrangler.json')
  writeFileSync(config, JSON.stringify({ name: 'synthetic-live-ui', main: resolve(import.meta.dirname, 'worker.ts'), compatibility_date: '2026-08-01', compatibility_flags: ['nodejs_compat'], d1_databases: [{ binding: 'DB', database_name: 'live-ui', database_id: '00000000000000000000000000000000' }], kv_namespaces: [{ binding: 'AUDIT_KV', id: '00000000000000000000000000000000' }] }))
  worker = await unstable_dev(resolve(import.meta.dirname, 'worker.ts'), { config, local: true, ip: '127.0.0.1', port: 0, inspectorPort: 0, persist: false, logLevel: 'error', experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false } })
  const target = `http://${worker.address}:${worker.port}`
  await build({ root: import.meta.dirname, configFile: false, define: { __WORKBASE_BUILD_SHA__: JSON.stringify('a'.repeat(40)) }, logLevel: 'silent', build: { outDir: join(scratch, 'dist'), emptyOutDir: true } })
  vite = await preview({
    root: import.meta.dirname, configFile: false, build: { outDir: join(scratch, 'dist') },
    preview: {
      host: '127.0.0.1', port: 0,
      headers: {
        'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-cache',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      },
      proxy: Object.fromEntries(['/build.json', '/api', '/query', '/me', '/o/', '/orgs', '/invitations', '/auth', '/__test'].map(path => [path, {
        target, changeOrigin: true,
        bypass: (request: { url?: string }) => request.url?.startsWith('/auth/complete') ? '/index.html' : undefined,
      }])),
    },
  })
  const address = vite.httpServer!.address() as { port: number }; origin = 'http://127.0.0.1:' + address.port
  // The test Worker consumes its trusted loopback origin from a control request.
  const seeded = await fetch(target + '/__test/seed', { headers: { ...control, 'X-Test-Origin': origin } })
  expect(seeded.status, await seeded.text()).toBe(200)
  browser = await chromium.launch({ channel: 'chromium', ignoreDefaultArgs: ['--disable-back-forward-cache'], ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) })
}, 60000)
afterAll(async () => { await browser?.close(); await vite?.close(); await worker?.stop(); if (scratch) rmSync(scratch, { recursive: true, force: true }); expect(forbiddenRequests).toEqual([]) })
let sessionIP = 0
async function newContext(options: Parameters<Browser['newContext']>[0]) {
  const context = await browser.newContext(options)
  context.on('request', request => { const path = new URL(request.url()).pathname; if (/(?:^|\/)(?:console-model|console-info|bootstrap|schema)(?:\/|$)/.test(path)) forbiddenRequests.push(path) })
  return context
}
async function session(role: string): Promise<BrowserContext> {
  const context = await newContext({ baseURL: origin, viewport: { width: 390, height: 844 }, hasTouch: true, extraHTTPHeaders: { 'cf-connecting-ip': '192.0.2.' + (++sessionIP) } })
  const sent = await context.request.post('/auth/sign-in/magic-link', { headers: { Origin: origin }, data: { email: role + '@example.test', callbackURL: '/me' } })
  expect(sent.status(), await sent.text()).toBe(200)
  const mail = await context.request.get('/__test/mail?email=' + role + '@example.test', { headers: control })
  const { link } = await mail.json()
  expect(link).toBeTruthy(); const signed = await context.request.get(link, { maxRedirects: 0 }); expect(signed.status(), await signed.text()).toBe(302)
  return context
}

// APIRequestContext does not send Secure cookies over HTTP loopback; the browser does.
async function cookieHeaders(context: BrowserContext) {
  return { Cookie: (await context.cookies()).map(cookie => cookie.name + '=' + cookie.value).join('; ') }
}
test.each([1500, 0])('sign-out then browser Back purges private DOM at pageshow (boot delay %i ms)', async delay => {
  const context = await session('admin'), page: Page = await context.newPage(), events: Restore[] = []
  page.setDefaultTimeout(10000)
  await page.exposeFunction('recordRestore', (value: Restore) => events.push(value))
  // Registered before app code: even the first pageshow listener must see a neutral document.
  await page.addInitScript(() => {
    window.addEventListener('pageshow', event => {
      window.recordRestore({ persisted: event.persisted, path: location.pathname, body: document.body.innerText, text: document.body.textContent ?? '' })
    })
  })
  const privateText = /Foreign bytes|Staff self|Create/
  try {
    await context.request.get('/__test/boot-delay?ms=0', { headers: control })
    await page.goto('/workers')
    await page.getByRole('button', { name: 'Foreign bytes', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Create', exact: true }).waitFor()
    // Two distinct documents leave the list in bfcache while logout replaces the detail.
    await page.goto('/workers/other')
    await page.getByText('Foreign bytes', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Sign out', exact: true }).first().click()
    await page.waitForURL('**/sign-in')
    expect((await context.request.get('/me', { headers: await cookieHeaders(context) })).status()).toBe(401)
    await context.request.get('/__test/boot-delay?ms=' + delay, { headers: control })
    await page.goBack({ waitUntil: 'commit' })
    await expect.poll(() => events.filter(event => event.persisted).length).toBe(1)
    const restored = events.filter(event => event.persisted)
    expect(restored[0].path).toBe('/workers')
    expect(restored[0].body).not.toMatch(privateText)
    expect(restored[0].text).not.toMatch(privateText)
    if (delay) {
      await page.waitForTimeout(500)
      expect(new URL(page.url()).pathname).toBe('/workers')
      expect(await page.locator('body').textContent()).not.toMatch(privateText)
      await page.getByRole('status').filter({ hasText: 'Loading' }).waitFor()
    }
    await expect.poll(() => new URL(page.url()).pathname).toBe('/sign-in')
    await page.getByLabel('Email', { exact: true }).waitFor()
    expect(await page.locator('body').textContent()).not.toMatch(privateText)
  } catch (error) {
    console.error('Restoration snapshots:', events, 'Current body:', await page.locator('body').innerText())
    throw error
  } finally {
    await context.request.get('/__test/boot-delay?ms=0', { headers: control })
    await context.close()
  }
}, 30000)
