import { test, expect } from '@playwright/test'
import setup from './runtime/setup'
import { gotoSDK, reloadSDK, observeSDKStylesheet } from './list-v2-readiness'

let stop: (() => Promise<void>) | undefined
test.beforeAll(async () => { stop = await setup({ worker: 'list-v2-worker.ts', seed: 'list-v2-seed.ts' }) })
test.afterAll(async () => { await stop?.() })

// Dedicated guard regression checks; never included in the 147-case acceptance.
test('real SDK CSS passes initial load and cache-revalidated reload readiness', async ({ page }, info) => {
  const statuses: number[] = []
  page.on('response', response => { if (/\/assets\/.*\.css$/.test(response.url())) statuses.push(response.status()) })
  observeSDKStylesheet(page)
  await gotoSDK(page, '/o/org-a/e/worker')
  await reloadSDK(page)
  await info.attach('stylesheet-statuses.json', { body: JSON.stringify(statuses), contentType: 'application/json' })
})
test('CSS 500 fails loudly before geometry can be asserted', async ({ page }) => {
  observeSDKStylesheet(page)
  await page.route('**/assets/*.css', route => route.fulfill({ status: 500, contentType: 'text/plain', body: 'readiness regression injection' }))
  await expect(gotoSDK(page, '/o/org-a/e/worker')).rejects.toThrow('SDK stylesheet readiness: stylesheet response must succeed')
})
test('HTTP 200 without SDK styles fails applied-style readiness', async ({ page }) => {
  observeSDKStylesheet(page)
  await page.route('**/assets/*.css', route => route.fulfill({ status: 200, contentType: 'text/css', body: '/* diagnostic empty stylesheet */' }))
  await expect(gotoSDK(page, '/o/org-a/e/worker')).rejects.toThrow('SDK stylesheet readiness: SDK list styles must be loaded and applied')
})
