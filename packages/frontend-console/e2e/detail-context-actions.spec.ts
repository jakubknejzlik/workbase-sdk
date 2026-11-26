import { test, expect, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import setup, { origin } from './runtime/setup'
import en from '../src/locales/en.json' with { type: 'json' }
import cs from '../src/locales/cs.json' with { type: 'json' }

// Reuse C1's real local SDK Worker/D1 and neutral worker/team configuration.
// No consumer changes or simulated page. Eventual consumer acceptance is separate.
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const output = process.env.DETAIL_CONTEXT_CAPTURES
if (!output) throw new Error('DETAIL_CONTEXT_CAPTURES must point to the requested evidence folder')
const build = JSON.parse(readFileSync(resolve(import.meta.dirname, '../dist/build-meta.json'), 'utf8'))
const captures: Record<string, unknown>[] = []
const longName = 'Žofie Příkladová Dlouhá — ukázková koordinátorka obecných úkolů a dlouhých názvů'
let stop: (() => Promise<void>) | undefined

test.beforeAll(async () => {
  expect(build.sourceCommit).toBe(head)
  mkdirSync(output, { recursive: true })
  stop = await setup({ worker: 'detail-identity-worker.ts', seed: 'list-v2-seed.ts' })
})
test.afterAll(async () => {
  writeFileSync(join(output, 'manifest.json'), JSON.stringify({ candidateSHA: head, build, target: 'Real SDK Worker/D1 + built console; neutral C1 worker/team shapes', captures }, null, 2) + '\n')
  await stop?.()
})
async function capture(page: Page, locale: string, width: number, state: string, target = 'worker') {
  await page.evaluate(async () => { await document.fonts.ready })
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.effect?.getComputedTiming().iterations === Infinity || animation.playState !== 'running' && !animation.pending))
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const file = `${target}-${locale}-${width}-${state}.png`
  await page.screenshot({ path: join(output!, file), fullPage: true })
  const bytes = readFileSync(join(output!, file))
  expect(bytes.readUInt32BE(16)).toBe(width)
  captures.push({ file, width, height: bytes.readUInt32BE(20), viewport: { width, height: 1000 }, locale, state, target, candidateSHA: head, sha256: createHash('sha256').update(bytes).digest('hex') })
}

for (const locale of ['en', 'cs'] as const) for (const width of [1440, 1280, 900, 390]) {
  test(`${locale}/${width}: contextual delete, keyboard cancel, pending/error and real once-only delete`, async ({ browser, request }) => {
    const labels = locale === 'cs' ? cs : en
    const headers = { Authorization: 'Bearer list-v2-admin-session', 'X-Organization-Id': 'org-a' }
    const created = await request.post(`${origin}/api/worker`, { headers, data: { name: longName, status: 'active', team_id: 'south' } })
    expect(created.status()).toBe(201)
    const id = (await created.json()).id
    const context = await browser.newContext({ baseURL: origin, viewport: { width, height: 1000 }, extraHTTPHeaders: { Authorization: headers.Authorization } })
    try {
      await context.addInitScript(language => localStorage.setItem('console-language', language), locale)
      const page = await context.newPage(), errors: string[] = [], violations: string[] = [], externalFonts: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      page.on('request', request => { if (/fonts\.(googleapis|gstatic)\.com/.test(request.url())) externalFonts.push(request.url()) })
      await page.addInitScript(() => document.addEventListener('securitypolicyviolation', event => console.error(`CSP:${event.violatedDirective}`)))
      page.on('console', message => { if (message.text().startsWith('CSP:')) violations.push(message.text()) })
      const response = await page.goto(`/o/org-a/e/worker/${id}`)
      const csp = response?.headers()['content-security-policy'] ?? ''
      const policy = csp.split(';').map(rule => rule.trim()).find(rule => rule.startsWith('font-src ')) ?? csp.split(';').map(rule => rule.trim()).find(rule => rule.startsWith('default-src '))
      expect(policy?.split(/\s+/).slice(1)).toEqual(["'self'"])
      await expect(page.getByRole('heading', { level: 1, name: longName })).toBeVisible()
      const font = await page.evaluate(async () => { await document.fonts.ready; return { family: getComputedStyle(document.querySelector('h1')!).fontFamily, loaded: document.fonts.check('16px Alata', 'Žofie Příkladová'), files: performance.getEntriesByType('resource').map(entry => entry.name).filter(url => /Alata.*\.ttf/.test(url)) } })
      expect(font.family).toContain('Alata'); expect(font.loaded).toBe(true); expect(font.files.some(url => url.startsWith(origin))).toBe(true)
      const trigger = page.locator('.wb-write-actions').getByRole('button', { name: labels.rowActions.replace('{{name}}', longName), exact: true })
      await expect(page.locator('.wb-write-actions').getByRole('button', { name: labels.edit, exact: true })).toHaveCount(1)
      await expect(page.locator('.wb-write-actions').getByRole('button', { name: labels.delete, exact: true })).toHaveCount(0)
      await capture(page, locale, width, 'menu-closed')
      for (let tab = 0; tab < 100 && !await trigger.evaluate(element => element === document.activeElement); tab++) await page.keyboard.press('Tab')
      await expect(trigger).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(page.getByRole('menuitem')).toHaveText(labels.delete)
      await capture(page, locale, width, 'menu-open')
      await page.keyboard.press('Enter')
      const dialog = page.getByRole('alertdialog', { name: labels.deleteRecord })
      await expect(dialog).toContainText(longName)
      const cancel = dialog.getByRole('button', { name: labels.cancel, exact: true })
      await expect(cancel).toBeFocused()
      await capture(page, locale, width, 'confirmation')
      await page.keyboard.press('Enter')
      await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused()
      expect(await trigger.evaluate(element => element.isConnected)).toBe(true)
      await capture(page, locale, width, 'cancel-focus-restored')

      // Deterministic transport delay/failure only; page, reads and server are real.
      let release!: () => void
      const gate = new Promise<void>(done => { release = done })
      let intercepted = 0
      const path = `**/api/worker/${id}`
      await page.route(path, async route => {
        if (route.request().method() !== 'DELETE') return route.continue()
        intercepted++; await gate
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'service_unavailable' }) })
      })
      await trigger.click(); await page.getByRole('menuitem', { name: labels.delete, exact: true }).click()
      await dialog.getByRole('button', { name: labels.delete, exact: true }).click()
      await expect(cancel).toBeDisabled()
      await page.keyboard.press('Enter'); await page.keyboard.press('Escape')
      await expect(dialog).toBeVisible()
      try { await capture(page, locale, width, 'saving-disabled') } finally { release() }
      await expect(cancel).toBeEnabled()
      await expect(dialog.getByRole('alert')).toBeVisible()
      expect(intercepted).toBe(1)
      await capture(page, locale, width, 'server-error')
      await cancel.click(); await expect(trigger).toBeFocused()
      await page.unroute(path)
      let deletes = 0
      page.on('request', request => { if (request.method() === 'DELETE' && request.url() === `${origin}/api/worker/${id}`) deletes++ })
      await trigger.click(); await page.getByRole('menuitem', { name: labels.delete, exact: true }).click()
      const deleted = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url() === `${origin}/api/worker/${id}`)
      await dialog.getByRole('button', { name: labels.delete, exact: true }).click()
      expect((await deleted).ok()).toBe(true)
      await expect(page).toHaveURL(`${origin}/o/org-a/e/worker`)
      expect(deletes).toBe(1)
      const check = await request.post(`${origin}/query`, { headers, data: { entity: 'worker', select: ['id'], where: { id: { eq: id } }, limit: 1 } })
      expect((await check.json()).data).toEqual([])
      await page.goto(`/o/org-a/e/worker/${id}`)
      await expect(page.getByRole('heading', { name: labels.notFound, exact: true })).toBeVisible()
      await expect(page.locator('.wb-write-actions')).toHaveCount(0)
      await capture(page, locale, width, 'missing-record')

      // Same C1 related-card surface; short identity and smaller target name.
      await page.goto('/o/org-a/e/team/south')
      await expect(page.getByRole('heading', { level: 1, name: 'South team' })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Related workers', exact: true })).toBeVisible()
      await capture(page, locale, width, 'menu-closed', 'team')
      const teamTrigger = page.locator('.wb-write-actions').getByRole('button', { name: labels.rowActions.replace('{{name}}', 'South team'), exact: true })
      await teamTrigger.click(); await capture(page, locale, width, 'menu-open', 'team')
      await page.getByRole('menuitem', { name: labels.delete, exact: true }).click()
      await expect(page.getByRole('alertdialog')).toContainText('South team')
      await capture(page, locale, width, 'confirmation', 'team')
      await page.getByRole('alertdialog').getByRole('button', { name: labels.cancel, exact: true }).click()
      await expect(teamTrigger).toBeFocused()
      expect(errors).toEqual([]); expect(violations).toEqual([]); expect(externalFonts).toEqual([])
      captures.push({ locale, width, font, csp, pageErrors: errors, cspViolations: violations, externalFonts, realDeleteRequests: deletes, injectedFailureRequests: intercepted })
    } finally { await context.close() }
    const reduced = await browser.newContext({ baseURL: origin, viewport: { width, height: 1000 }, extraHTTPHeaders: { Authorization: 'Bearer list-v2-staff-session' } })
    try {
      await reduced.addInitScript(language => localStorage.setItem('console-language', language), locale)
      const page = await reduced.newPage()
      await page.goto('/o/org-a/e/worker/w004')
      await expect(page.getByRole('heading', { level: 1, name: 'Worker 004' })).toBeVisible()
      await expect(page.locator('.wb-write-actions').getByRole('button')).toHaveCount(0)
      await capture(page, locale, width, 'permission-reduced-no-menu')
    } finally { await reduced.close() }
  })
}
