import { test, expect, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import setup, { origin } from './runtime/setup'
import en from '../src/locales/en.json' with { type: 'json' }
import cs from '../src/locales/cs.json' with { type: 'json' }

// Real SDK Worker + D1 + built console. Synthetic worker/team shapes only;
// eventual Cleaning/Infodental acceptance is a separate integration gate.
const output = process.env.DETAIL_IDENTITY_CAPTURES ?? join(tmpdir(), 'detail-identity-captures')
const longName = 'Žaneta Šťastná Dlouhá — zdravotní technik a koordinátorka odborné péče'
let stop: (() => Promise<void>) | undefined
let longId: string
const captures: Record<string, unknown>[] = []
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const build = JSON.parse(readFileSync(resolve(import.meta.dirname, '../dist/build-meta.json'), 'utf8'))

test.beforeAll(async ({ request }) => {
  expect(build.sourceCommit).toBe(head)
  mkdirSync(output, { recursive: true })
  stop = await setup({ worker: 'detail-identity-worker.ts', seed: 'list-v2-seed.ts' })
  const created = await request.post(`${origin}/api/worker`, { headers: { Authorization: 'Bearer list-v2-admin-session', 'X-Organization-Id': 'org-a' }, data: { name: longName, status: 'active', team_id: 'south' } })
  expect(created.status()).toBe(201)
  longId = (await created.json()).id
  expect(longId.length).toBeGreaterThan(30)
})
test.afterAll(async () => {
  writeFileSync(join(output, 'manifest.json'), JSON.stringify({ candidateSHA: head, build, target: 'real local SDK Worker/D1; neutral worker/team fixtures', captures }, null, 2) + '\n')
  await stop?.()
})

async function capture(page: Page, locale: string, width: number, state: string, target = 'worker') {
  await page.evaluate(async () => { await document.fonts.ready })
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.effect?.getComputedTiming().iterations === Infinity || animation.playState !== 'running' && !animation.pending))
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const file = `${target}-${locale}-${width}-${state}.png`
  await page.screenshot({ path: join(output, file), fullPage: true })
  const bytes = readFileSync(join(output, file))
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  expect(bytes.readUInt32BE(16)).toBe(width)
  captures.push({ file, width, height: bytes.readUInt32BE(20), viewport: { width, height: 1000 }, locale, state, target, candidateSHA: head, sha256: createHash('sha256').update(bytes).digest('hex') })
}

for (const locale of ['en', 'cs'] as const) for (const width of [1440, 1280, 900, 390]) {
  test(`${locale}/${width}: full identity, clipboard, editor states and reduced permissions`, async ({ browser }) => {
    const labels = locale === 'en' ? en : cs
    const context = await browser.newContext({ baseURL: origin, viewport: { width, height: 1000 }, locale: locale === 'cs' ? 'cs-CZ' : 'en-US',
      extraHTTPHeaders: { Authorization: 'Bearer list-v2-admin-session' }, permissions: ['clipboard-read', 'clipboard-write'],
    })
    try {
      await context.addInitScript(language => localStorage.setItem('console-language', language), locale)
      const page = await context.newPage()
      const errors: string[] = [], violations: string[] = [], externalFonts: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      page.on('request', request => { if (/fonts\.(googleapis|gstatic)\.com/.test(request.url())) externalFonts.push(request.url()) })
      await page.addInitScript(() => document.addEventListener('securitypolicyviolation', event => console.error(`CSP:${event.violatedDirective}`)))
      page.on('console', message => { if (message.text().startsWith('CSP:')) violations.push(message.text()) })
      const response = await page.goto(`/o/org-a/e/worker/${longId}`)
      const csp = response?.headers()['content-security-policy'] ?? ''
      // Font loading inherits default-src when font-src is omitted.
      const fontPolicy = csp.split(';').map(rule => rule.trim()).find(rule => rule.startsWith('font-src ')) ?? csp.split(';').map(rule => rule.trim()).find(rule => rule.startsWith('default-src '))
      expect(fontPolicy?.split(/\s+/).slice(1)).toEqual(["'self'"])
      await expect(page.getByRole('heading', { level: 1, name: longName })).toBeVisible()
      if (width === 390) expect((await page.getByRole('heading', { level: 1, name: longName }).boundingBox())!.width).toBeGreaterThan(300)
      const identity = page.locator('.generated-detail-identity')
      const text = identity.getByText(longId, { exact: true })
      await expect(text).toBeVisible()
      const metrics = await text.evaluate(element => ({ whiteSpace: getComputedStyle(element).whiteSpace, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }))
      expect(metrics.whiteSpace).toBe('normal')
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1)
      const font = await page.evaluate(async () => {
        await document.fonts.ready
        return { family: getComputedStyle(document.querySelector('h1')!).fontFamily,
          loaded: document.fonts.check('16px Alata', 'Žaneta Šťastná'),
          files: performance.getEntriesByType('resource').map(entry => entry.name).filter(url => /Alata.*\.ttf/.test(url)) }
      })
      expect(font.family).toContain('Alata'); expect(font.loaded).toBe(true)
      expect(font.files.some(url => url.startsWith(origin))).toBe(true)
      await capture(page, locale, width, 'populated')
      const button = identity.getByRole('button', { name: labels.listIdentifierCopy })
      // Native keyboard activation and full (unshortened) clipboard value.
      for (let tab = 0; tab < 80 && !await button.evaluate(element => element === document.activeElement); tab++) await page.keyboard.press('Tab')
      await expect(button).toBeFocused()
      expect(await button.evaluate(element => element.matches(':focus-visible'))).toBe(true)
      await capture(page, locale, width, 'copy-focused')
      await page.keyboard.press('Enter')
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(longId)
      await expect(identity.getByRole('status')).toHaveText(labels.listIdentifierCopied)
      await capture(page, locale, width, 'copy-success')
      await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')) } }))
      await button.click()
      await expect(identity.getByRole('status')).toHaveText(labels.listIdentifierCopyFailed)
      await capture(page, locale, width, 'clipboard-denied')

      await page.getByRole('button', { name: labels.edit, exact: true }).click()
      const dialog = page.getByRole('dialog')
      const name = dialog.getByRole('textbox', { name: labels.field_name, exact: true })
      await name.fill('')
      await dialog.getByRole('button', { name: labels.save, exact: true }).click()
      await expect(dialog.getByRole('alert').first()).toBeVisible()
      await capture(page, locale, width, 'server-validation-error')
      await name.fill(`${longName} — změna`)
      await capture(page, locale, width, 'modified')
      // Hold a write before returning a controlled server failure. Reads and the
      // built page remain real; this injection specifically tests retained draft.
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      await page.route('**/api/worker/*', async route => {
        if (route.request().method() !== 'PATCH') return route.continue()
        await gate
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'service_unavailable' }) })
      })
      await dialog.getByRole('button', { name: labels.save, exact: true }).click()
      await expect(name).toBeDisabled()
      try { await capture(page, locale, width, 'saving-disabled') } finally { release() }
      await expect(name).toBeEnabled()
      await expect(name).toHaveValue(`${longName} — změna`)
      await expect(dialog.getByRole('alert').first()).toBeVisible()
      await capture(page, locale, width, 'server-error-retained-draft')
      // A new page discards the test-only draft without submitting it.
      await page.close()
      const detail = await context.newPage()
      await detail.goto('/o/org-a/e/team/south')
      await expect(detail.getByRole('heading', { level: 1, name: 'South team' })).toBeVisible()
      await expect(detail.locator('.generated-detail-identity').getByText('south', { exact: true })).toBeVisible()
      await expect(detail.getByRole('heading', { name: 'Related workers', exact: true })).toBeVisible()
      await expect(detail.getByText('Worker 002', { exact: true }).filter({ visible: true }).first()).toBeVisible()
      await capture(detail, locale, width, 'short-id-related-list', 'team')
      await detail.getByRole('button', { name: labels.edit, exact: true }).click()
      await expect(detail.getByRole('dialog')).toBeVisible()
      await capture(detail, locale, width, 'small-edit', 'team')
      await detail.getByRole('dialog').getByRole('button', { name: labels.cancel, exact: true }).click()
      await detail.goto('/o/org-a/e/team')
      await detail.getByRole('button', { name: /^(Add|Přidat) / }).first().click()
      await expect(detail.getByRole('dialog')).toBeVisible()
      await capture(detail, locale, width, 'empty-create', 'team')
      await detail.getByRole('dialog').getByRole('button', { name: labels.cancel, exact: true }).click()
      await detail.goto('/o/org-a/e/worker')
      await detail.getByRole('button', { name: /^(Add|Přidat) / }).first().click()
      await expect(detail.getByRole('dialog')).toBeVisible()
      await capture(detail, locale, width, 'longer-empty-create')
      await detail.getByRole('dialog').getByRole('button', { name: labels.cancel, exact: true }).click()
      await detail.goto('/o/org-a/e/worker/does-not-exist')
      await expect(detail.getByRole('heading', { name: labels.notFound })).toBeVisible()
      await expect(detail.locator('.generated-detail-identity')).toHaveCount(0)
      await capture(detail, locale, width, 'missing-record')
      expect(errors).toEqual([]); expect(violations).toEqual([]); expect(externalFonts).toEqual([])
      captures.push({ locale, width, font, metrics, pageErrors: errors, cspViolations: violations, externalFonts })
    } finally { await context.close() }
    const reduced = await browser.newContext({ baseURL: origin, viewport: { width, height: 1000 },
      extraHTTPHeaders: { Authorization: 'Bearer list-v2-staff-session' },
    })
    try {
      await reduced.addInitScript(language => localStorage.setItem('console-language', language), locale)
      const page = await reduced.newPage()
      await page.goto('/o/org-a/e/worker/w004')
      await expect(page.getByRole('heading', { level: 1, name: 'Worker 004' })).toBeVisible()
      await expect(page.getByRole('button', { name: labels.edit, exact: true })).toHaveCount(0)
      await expect(page.locator('.generated-detail-identity').getByText('w004', { exact: true })).toBeVisible()
      await capture(page, locale, width, 'permission-reduced')
    } finally { await reduced.close() }
  })
}
