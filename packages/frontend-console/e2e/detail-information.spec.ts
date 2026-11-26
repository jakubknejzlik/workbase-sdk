import { test, expect, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import setup, { origin } from './runtime/setup'
import en from '../src/locales/en.json' with { type: 'json' }
import cs from '../src/locales/cs.json' with { type: 'json' }

const output = process.env.DETAIL_INFORMATION_CAPTURES ?? join(tmpdir(), 'detail-information-captures')
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const build = JSON.parse(readFileSync(resolve(import.meta.dirname, '../dist/build-meta.json'), 'utf8'))
const captures: Record<string, unknown>[] = []
const checks: Record<string, unknown>[] = []
let stop: (() => Promise<void>) | undefined
test.beforeAll(async () => {
  expect(build.sourceCommit).toBe(head)
  mkdirSync(output, { recursive: true })
  stop = await setup({ worker: 'detail-information-worker.ts', seed: 'detail-information-seed.ts' })
})
test.afterAll(async () => {
  writeFileSync(join(output, 'capture-manifest.json'), JSON.stringify({ candidateSHA: head, build,
    target: 'Real local SDK Worker/D1 and built console, neutral member/pass shapes',
    panel: 'No routed detail panel at P; member full-page renderer compared to panel metadata references only.',
    referenceMapping: { specimens: ['member-detail-1440', 'member-panel-1440', 'member-panel-390'], containers: ['pass-detail-1280', 'pass-detail-390'],
      missingWidths: 'Bracketing images plus static responsive rules; no same-width reference at 900, member 1280 or pass 1440.' },
    captures, checks }, null, 2) + '\n')
  await stop?.()
})

async function capture(page: Page, locale: string, width: number, state: string, target: string) {
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
  test(`${locale}/${width}: member metadata, paired pass facts, fallback and hidden operands`, async ({ browser }) => {
    const labels = locale === 'en' ? en : cs
    for (const role of ['owner', 'viewer']) {
      const context = await browser.newContext({ baseURL: origin, viewport: { width, height: 1000 }, locale: locale === 'cs' ? 'cs-CZ' : 'en-US', extraHTTPHeaders: { Authorization: `Bearer w29-${role}-session` } })
      try {
        await context.addInitScript(language => localStorage.setItem('console-language', language), locale)
        const page = await context.newPage()
        const errors: string[] = [], violations: string[] = [], externalFonts: string[] = []
        page.on('pageerror', error => errors.push(error.message))
        page.on('request', request => { if (/fonts\.(googleapis|gstatic)\.com/.test(request.url())) externalFonts.push(request.url()) })
        await page.addInitScript(() => document.addEventListener('securitypolicyviolation', event => console.error(`CSP:${event.violatedDirective}`)))
        page.on('console', message => { if (message.text().startsWith('CSP:')) violations.push(message.text()) })
        for (const entity of ['specimens', 'containers']) {
          for (const state of role === 'owner' ? ['populated', 'missing', 'not-applicable'] : ['permission-reduced']) {
            const response = await page.goto(`/o/org-a/e/${entity}/${state === 'permission-reduced' ? 'populated' : state}`)
            expect(response?.ok()).toBe(true)
            await expect(page.locator('[data-detail-group]')).toBeVisible()
            const note = page.locator('[data-detail-field="note"]')
            // enabled is an authorized conditional query operand for owner only.
            // It is never a display row; viewer's projection removes the dependent too.
            await expect(page.locator('[data-detail-field="enabled"]')).toHaveCount(0)
            if (role === 'viewer') {
              await expect(note).toHaveCount(0)
              await expect(page.getByRole('button', { name: labels.edit, exact: true })).toHaveCount(0)
            } else {
              await expect(note).toHaveAttribute('data-detail-state', state === 'populated' ? 'provided' : state === 'missing' ? 'not-provided' : 'not-applicable')
              if (state === 'missing') await expect(note).toContainText(labels.detailNotProvided)
              if (state === 'not-applicable') {
                await expect(note).toContainText(labels.detailNotApplicable)
                await expect(page.getByText('Hidden conditional content')).toHaveCount(0)
                await expect(note.getByRole('button')).toHaveCount(0)
              }
              const fieldHelp = note.locator('.detail-field-help')
              await expect(fieldHelp).toHaveText(labels.detailConditionalHelp)
              await expect(note.locator('dt')).toHaveText(locale === 'cs' ? 'Doplňující údaje pro původní registraci a následné ověření členství v organizaci' : 'Additional registration information')
              expect(await fieldHelp.evaluate(element => element.parentElement?.tagName)).toBe('DD')
            }
            await expect(page.locator('.detail-group-heading > p')).toHaveText(labels.detailInformationHelp)
            const ref = page.locator(`[data-detail-field="${entity === 'specimens' ? 'parent_id' : 'specimen_id'}"]`)
            if (state !== 'missing') await expect(ref.getByRole('link')).toHaveAttribute('href', /\/o\/org-a\/e\/(containers|specimens)\/populated/)
            const metadata = page.locator('[data-detail-group] [data-detail-field]')
            const positions = await metadata.evaluateAll(elements => elements.map(element => ({ x: element.getBoundingClientRect().x, y: element.getBoundingClientRect().y })))
            expect(positions.length).toBeGreaterThan(0)
            const groupWidth = await page.locator('.detail-information').evaluate(element => element.clientWidth)
            if (positions.length > 1) expect(positions[0].y === positions[1].y).toBe(groupWidth > 530)
            if (entity === 'containers') {
              const pair = await page.locator('[data-detail-summary] [data-detail-field]').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().y))
              expect(pair).toHaveLength(2); expect(pair[0]).toBe(pair[1])
            }
            const metrics = await metadata.first().evaluate(element => {
              const style = (selector: string) => { const s = getComputedStyle(element.querySelector(selector)!); return { fontSize: s.fontSize, lineHeight: s.lineHeight, family: s.fontFamily } }
              return { label: style('dt'), value: style('dd'), separator: getComputedStyle(element).borderTopWidth }
            })
            expect(metrics.label.fontSize).toBe('11px'); expect(metrics.value.fontSize).toBe('13px'); expect(metrics.separator).toBe('1px')
            const font = await page.evaluate(async () => { await document.fonts.ready; return { loaded: document.fonts.check('13px Alata', 'Žaneta Šťastná'), files: performance.getEntriesByType('resource').map(entry => entry.name).filter(url => /Alata.*\.ttf/.test(url)) } })
            expect(font.loaded).toBe(true); expect(font.files.some(url => url.startsWith(origin))).toBe(true)
            const csp = response?.headers()['content-security-policy'] ?? ''
            const fontPolicy = csp.split(';').map(rule => rule.trim()).find(rule => rule.startsWith('font-src ')) ?? csp.split(';').map(rule => rule.trim()).find(rule => rule.startsWith('default-src '))
            expect(fontPolicy?.split(/\s+/).slice(1)).toEqual(["'self'"])
            await capture(page, locale, width, state, entity)
            checks.push({ locale, width, role, entity, state, groupWidth, metrics, font })
          }
        }
        if (role === 'owner') {
          await page.goto('/o/org-a/e/folders/fallback')
          await expect(page.locator('.detail-fields')).toBeVisible()
          await expect(page.locator('[data-detail-field="name"]')).toContainText('Archiv registračních údajů')
          const positions = await page.locator('.detail-fields > [data-detail-field]').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().y))
          const available = await page.locator('.detail-fields').evaluate(element => element.clientWidth)
          expect(positions[0] === positions[1]).toBe(available > 530)
          await capture(page, locale, width, 'fallback', 'folders')
        }
        expect(errors).toEqual([]); expect(violations).toEqual([]); expect(externalFonts).toEqual([])
      } finally { await context.close() }
    }
  })
}
