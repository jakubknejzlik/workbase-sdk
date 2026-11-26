import { test, expect, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import setup, { origin } from './runtime/setup'
import en from '../src/locales/en.json' with { type: 'json' }
import cs from '../src/locales/cs.json' with { type: 'json' }

let stop: (() => Promise<void>) | undefined
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
test.beforeAll(async () => { expect(JSON.parse(readFileSync(new URL('../dist/build-meta.json', import.meta.url), 'utf8')).sourceCommit).toBe(head); stop = await setup({ worker: 'widget-drilldown-worker.ts', seed: 'widget-drilldown-seed.ts' }) })
test.afterAll(async () => { await stop?.() })
async function keyboardOpen(page: Page, link: ReturnType<Page['getByRole']>) {
  for (let step = 0; step < 80 && !await link.evaluate(node => node === document.activeElement); step++) await page.keyboard.press('Tab')
  await expect(link).toBeFocused()
  await page.keyboard.press('Enter')
}

test('named-view links open the full matching server list, keep record/reference targets, and return with Back', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('console-language', 'en'))
  const result = page.waitForResponse(response => response.url().endsWith('/console-pages/neutral.home'))
  await page.goto('/o/org-a/')
  const widgets = (await (await result).json()).widgets
  expect(widgets.find((widget: { id: string }) => widget.id === 'count').value).toBe(17)
  expect(widgets.find((widget: { id: string }) => widget.id === 'attention').data).toHaveLength(5)
  await expect(page.locator('[data-widget="names-without-id"]').getByRole('link')).toHaveCount(0)
  for (const id of ['count', 'attention', 'names']) {
    const link = page.locator(`[data-widget="${id}"]`).getByRole('link', { name: en.dashboardViewMatchingRecords })
    await expect(link).toHaveAttribute('href', '/o/org-a/e/specimens?view=attention&page=1')
    const queryResponse = id === 'count' ? page.waitForResponse(response => response.url().endsWith('/query') && response.request().postDataJSON()?.view === 'attention') : undefined
    await keyboardOpen(page, link)
    await expect(page).toHaveURL(/\/o\/org-a\/e\/specimens\?view=attention&page=1$/)
    if (queryResponse) {
      const response = await queryResponse
      const query = response.request().postDataJSON()
      expect(query).toMatchObject({ entity: 'specimens', view: 'attention', offset: 0, limit: 10, includeTotal: true })
      expect(response.request().headers()['x-organization-id']).toBe('org-a')
      const first = await response.json()
      expect(first.total).toBe(17)
      expect(first.data).toHaveLength(10)
      expect(first.data.every((row: { status: string }) => row.status === 'Pending confirmation')).toBe(true)
    }
    await expect(page.locator('[data-list-range]')).toHaveText('1–10 of 17')
    await expect(page.locator('main tbody tr')).toHaveCount(10)
    for (const row of await page.locator('main tbody tr').all()) await expect(row).toContainText('Pending confirmation')
    const firstIds = await page.locator('main [data-row-name]').evaluateAll(nodes => nodes.map(node => node.getAttribute('href')))
    const secondResponse = id === 'count' ? page.waitForResponse(response => response.url().endsWith('/query') && response.request().postDataJSON()?.offset === 10) : undefined
    await page.getByRole('button', { name: en.nextPage, exact: true }).click()
    if (secondResponse) {
      const second = await (await secondResponse).json()
      expect(second.total).toBe(17)
      expect(second.data).toHaveLength(7)
      expect(second.data.every((row: { status: string }) => row.status === 'Pending confirmation')).toBe(true)
    }
    await expect(page.locator('[data-list-range]')).toHaveText('11–17 of 17')
    await expect(page.locator('main tbody tr')).toHaveCount(7)
    for (const row of await page.locator('main tbody tr').all()) await expect(row).toContainText('Pending confirmation')
    const secondIds = await page.locator('main [data-row-name]').evaluateAll(nodes => nodes.map(node => node.getAttribute('href')))
    expect([...firstIds, ...secondIds].sort()).toEqual(Array.from({ length: 17 }, (_, index) => `/o/org-a/e/specimens/org-a-booking-${String(index).padStart(2, '0')}`))
    await page.goBack()
    await expect(page.locator('[data-list-range]')).toHaveText('1–10 of 17')
    await page.goBack()
    await expect(page).toHaveURL(/\/o\/org-a\/$/)
    await expect(page.locator('[data-widget="count"]')).toContainText('17')
  }
  for (const id of ['attention', 'names']) {
    const link = page.locator(`[data-widget="${id}"] [data-row-name]`).first()
    await expect(link).toHaveText('Alex Example')
    await keyboardOpen(page, link)
    await expect(page).toHaveURL(/\/o\/org-a\/e\/specimens\/org-a-booking-00$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Alex Example', exact: true })).toBeVisible()
    await page.goBack()
  }
  const reference = page.locator('[data-widget="attention"]').getByRole('link', { name: 'Alex Example', exact: true }).nth(1)
  await expect(reference).toHaveAttribute('href', '/o/org-a/e/clients/org-a-example')
  await keyboardOpen(page, reference)
  await expect(page).toHaveURL(/\/o\/org-a\/e\/clients\/org-a-example$/)
  await page.goBack()
  const zero = page.locator('[data-widget="zero"]')
  await expect(zero.getByText('0', { exact: true })).toBeVisible()
  await keyboardOpen(page, zero.getByRole('link', { name: en.dashboardViewMatchingRecords }))
  await expect(page).toHaveURL(/view=empty&page=1$/)
  await expect(page.locator('[data-list-range]')).toHaveText('0–0 of 0')
})

test('encoded organization browser navigation preserves exact server membership and rejects foreign scope', async ({ page, request }) => {
  const scopedPaths: string[] = []
  page.on('request', request => { const path = new URL(request.url()).pathname; if (path.startsWith('/o/')) scopedPaths.push(path) })
  await page.addInitScript(() => localStorage.setItem('console-language', 'en'))
  await page.goto('/o/org%20%2Fencoded/')
  const link = page.locator('[data-widget="count"]').getByRole('link', { name: en.dashboardViewMatchingRecords })
  await expect(link).toHaveAttribute('href', '/o/org%20%2Fencoded/e/specimens?view=attention&page=1')
  const firstResponse = page.waitForResponse(response => response.url().endsWith('/query') && response.request().postDataJSON()?.view === 'attention')
  await keyboardOpen(page, link)
  await expect(page).toHaveURL(/\/o\/org%20%2Fencoded\/e\/specimens\?view=attention&page=1$/)
  const response = await firstResponse
  expect(response.request().headers()['x-organization-id']).toBe('org /encoded')
  const first = await response.json()
  expect(first.total).toBe(17)
  expect(first.data.map((row: { id: string }) => row.id)).toEqual(Array.from({ length: 10 }, (_, index) => `org /encoded-booking-${String(index).padStart(2, '0')}`))
  await expect(page.locator('[data-list-range]')).toHaveText('1–10 of 17')
  await expect(page.locator('main tbody tr')).toHaveCount(10)
  const secondResponse = page.waitForResponse(response => response.url().endsWith('/query') && response.request().postDataJSON()?.offset === 10)
  await page.getByRole('button', { name: en.nextPage, exact: true }).click()
  const second = await (await secondResponse).json()
  expect(second.total).toBe(17)
  expect(second.data.map((row: { id: string }) => row.id)).toEqual(Array.from({ length: 7 }, (_, index) => `org /encoded-booking-${String(index + 10).padStart(2, '0')}`))
  await expect(page.locator('[data-list-range]')).toHaveText('11–17 of 17')
  await expect(page.locator('main tbody tr')).toHaveCount(7)
  await page.goBack()
  await expect(page.locator('[data-list-range]')).toHaveText('1–10 of 17')
  await page.goBack()
  await expect(page).toHaveURL(/\/o\/org%20%2Fencoded\/$/)
  await expect(link).toBeVisible()
  expect(scopedPaths.length).toBeGreaterThan(0)
  expect(scopedPaths.every(path => path.split('/')[2] === 'org%20%2Fencoded')).toBe(true)
  for (const path of ['/o/org-other/console-model', '/o/org-other/console-pages/neutral.home']) expect((await request.get(path, { headers: { 'X-Organization-Id': 'org-other' } })).status()).toBe(403)
  expect((await request.post('/query', { headers: { 'X-Organization-Id': 'org-other' }, data: { entity: 'specimens', view: 'attention', select: ['id'], offset: 0, limit: 10, includeTotal: true } })).status()).toBe(403)
})

for (const locale of ['en', 'cs'] as const) for (const width of [1440, 1280, 900, 390]) test(`${locale}/${width}: built supported home dashboard states`, async ({ browser }) => {
  const copy = locale === 'cs' ? cs : en
  for (const state of ['populated', 'empty', 'zero', 'loading', 'error', 'permission-reduced']) {
    const context = await browser.newContext({ baseURL: origin, viewport: { width, height: 1000 }, extraHTTPHeaders: { Authorization: 'Bearer w29-owner-session' } })
    await context.addInitScript(locale => localStorage.setItem('console-language', locale), locale)
    const page = await context.newPage()
    const errors: string[] = [], externalFonts: string[] = [], cspErrors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => { if (/fonts\.(googleapis|gstatic)\.com/.test(request.url())) externalFonts.push(request.url()) })
    page.on('console', message => { if (/content security policy|refused to load.*font/i.test(message.text())) cspErrors.push(message.text()) })
    let release: (() => void) | undefined
    try {
      if (state === 'loading') {
        const wait = new Promise<void>(resolve => { release = resolve })
        await page.route('**/console-pages/neutral.home', async route => { await wait; await route.continue() })
      }
      if (state === 'error') await page.route('**/console-pages/neutral.home', async route => {
        const response = await route.fetch(), body = await response.json()
        body.widgets = body.widgets.map((widget: { id: string; label: string }) => widget.id === 'attention' ? { id: widget.id, label: widget.label, kind: 'error', code: 'widget_failed' } : widget)
        await route.fulfill({ response, json: body })
      })
      if (state === 'permission-reduced') {
        // The real viewer projection removes status-filtered widgets and create/command actions.
        await page.route('**/console-model', async route => {
          const response = await route.fetch({ headers: { ...route.request().headers(), Authorization: 'Bearer w29-viewer-session' } })
          await route.fulfill({ response })
        })
        await page.route('**/console-pages/neutral.home', async route => {
          const response = await route.fetch({ headers: { ...route.request().headers(), Authorization: 'Bearer w29-viewer-session' } })
          await route.fulfill({ response })
        })
      }
      const response = await page.goto(state === 'empty' || state === 'zero' ? '/o/org-empty/' : '/o/org-a/')
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      if (state === 'loading') await expect(page.getByRole('status', { name: copy.loading }).first()).toBeVisible()
      else if (state === 'permission-reduced') {
        await expect(page.locator('[data-widget="unsupported"]')).toBeVisible()
        await expect(page.locator('[data-widget="attention"]')).toHaveCount(0)
        await expect(page.getByRole('link', { name: copy.dashboardViewMatchingRecords })).toHaveCount(0)
      } else {
        await expect(page.locator('[data-widget="count"]')).toContainText(state === 'populated' || state === 'error' ? '17' : '0')
        if (state === 'error') {
          await expect(page.locator('[data-widget="attention"]').getByRole('alert')).toBeVisible()
          await expect(page.locator('[data-widget="attention"]').getByRole('link')).toHaveCount(0)
        }
        await expect(page.locator('[data-widget="missing"]').getByRole('link')).toHaveCount(0)
        await expect(page.locator('[data-widget="unsupported"]').getByRole('link')).toHaveCount(0)
      }
      await page.evaluate(async () => { await document.fonts.ready })
      const font = await page.evaluate(() => ({ family: getComputedStyle(document.querySelector('h1')!).fontFamily, loaded: document.fonts.check('16px Alata', 'Příliš žluťoučký kůň'), files: performance.getEntriesByType('resource').map(entry => entry.name).filter(url => /Alata.*\.ttf/.test(url)) }))
      expect(font.family).toContain('Alata')
      expect(font.loaded).toBe(true)
      expect(font.files.some(url => url.startsWith(origin))).toBe(true)
      expect(externalFonts).toEqual([])
      expect(cspErrors).toEqual([])
      const csp = response!.headers()['content-security-policy']
      const directives = csp.split(';').map(value => value.trim())
      expect(directives.find(value => value.startsWith('font-src ')) ?? directives.find(value => value.startsWith('default-src '))).toBe("default-src 'self'")
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(errors).toEqual([])
      if (state === 'populated') expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
      if (process.env.WIDGET_DRILLDOWN_OUTPUT) {
        const directory = process.env.WIDGET_DRILLDOWN_OUTPUT
        mkdirSync(directory, { recursive: true })
        const file = `${head}-${locale}-${width}-${state}.png`, path = join(directory, file)
        await page.screenshot({ path, fullPage: true, animations: 'disabled' })
        const manifest = join(directory, 'manifest.json'), entries = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : []
        entries.push({ file, width, locale, state, headSHA: head, sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), font, externalFonts, cspErrors, csp: response!.headers()['content-security-policy'], build: JSON.parse(readFileSync(new URL('../dist/build-meta.json', import.meta.url), 'utf8')) })
        writeFileSync(manifest, JSON.stringify(entries, null, 2) + '\n')
      }
    } finally { release?.(); await context.close() }
  }
})

test('live permission revocation removes cached matching links', async ({ page, request }) => {
  await page.addInitScript(() => localStorage.setItem('console-language', 'en'))
  await page.goto('/o/org-a/')
  await expect(page.locator('[data-widget="count"]').getByRole('link', { name: en.dashboardViewMatchingRecords })).toBeVisible()
  expect((await request.post('/__test/restrict', { headers: { Authorization: 'Bearer w29-local-control' } })).ok()).toBe(true)
  // Existing live authority polling drives the real projection change.
  await expect(page.getByRole('link', { name: en.dashboardViewMatchingRecords })).toHaveCount(0, { timeout: 40_000 })
  await expect(page.locator('[data-widget="attention"]')).toHaveCount(0)
})
