import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import setup, { origin } from './runtime/setup'
import { gotoSDK } from './list-v2-readiness'
import { seedTime } from './runtime/list-v2-data'
import en from '../src/locales/en.json' with { type: 'json' }
import cs from '../src/locales/cs.json' with { type: 'json' }

const output = process.env.IDENTIFIER_COPY_CAPTURES ?? join(tmpdir(), 'identifier-copy-captures')
let stop: (() => Promise<void>) | undefined
test.beforeAll(async () => { stop = await setup({ worker: 'metadata-list-worker.ts', seed: 'list-v2-seed.ts' }) })
test.afterAll(async () => { await stop?.() })

test('identifier icon copy keeps seeded table/cards geometry at 1440/390 in EN/CS', async ({ browser }) => {
  mkdirSync(output, { recursive: true })
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const build = JSON.parse(readFileSync(resolve(import.meta.dirname, '../dist/build-meta.json'), 'utf8'))
  expect(build.sourceCommit).toBe(head)
  const seedContext = await browser.newContext({ baseURL: origin, extraHTTPHeaders: { Authorization: 'Bearer list-v2-admin-session', 'X-Organization-Id': 'org-a' } })
  // Add one long ID through the real SDK mutation endpoint, beside the existing short-ID seed.
  let longId: string
  try {
    const created = await seedContext.request.post('/api/worker', { data: { name: 'Worker 001 long identifier', code: 'LONG', status: 'active' } })
    expect(created.status()).toBe(201)
    longId = (await created.json()).id
    expect(longId.length).toBeGreaterThan(30)
  } finally { await seedContext.close() }
  const captures: Record<string, unknown>[] = []
  for (const language of ['en', 'cs'] as const) for (const width of [1440, 390]) {
    const context = await browser.newContext({ baseURL: origin, viewport: { width, height: 1000 }, locale: language === 'cs' ? 'cs-CZ' : 'en-US',
      extraHTTPHeaders: { Authorization: 'Bearer list-v2-admin-session' }, permissions: ['clipboard-read', 'clipboard-write'],
    })
    try {
      await context.addInitScript(locale => localStorage.setItem('console-language', locale), language)
      const page = await context.newPage()
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
      const documentResponse = await context.request.get('/o/org-a/console-model')
      expect(documentResponse.ok()).toBe(true)
      const document = await documentResponse.json()
      expect(document.capabilities.entities.worker.readable).toEqual(expect.arrayContaining(['id', 'updated_at']))
      expect(document.model.entities.worker.fields.updated_at.readOnly).toBe(true)
      const query = page.waitForResponse(response => new URL(response.url()).pathname === '/query' && response.request().postDataJSON()?.entity === 'worker' && response.request().postDataJSON()?.includeTotal === true)
      await gotoSDK(page, '/o/org-a/e/worker')
      const queryResponse = await query; expect(queryResponse.status()).toBe(200)
      const body = await queryResponse.json()
      expect(body.data.length).toBeGreaterThan(0)
      const first = body.data[0]
      expect(first.id).toMatch(/^w\d+$/); expect(first.updated_at).toBe(seedTime)
      const surface = width === 1440 ? page.locator('tbody tr').first() : page.locator('dl').first()
      await expect(surface.getByText(first.id, { exact: true })).toBeVisible()
      const formatted = new Intl.DateTimeFormat(language === 'cs' ? 'cs-CZ' : 'en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Prague' }).format(new Date(first.updated_at))
      await expect(surface.getByText(formatted, { exact: true })).toBeVisible()
      const copyLabel = language === 'cs' ? cs.listIdentifierCopy : en.listIdentifierCopy
      await page.evaluate(async () => { await document.fonts.ready })
      const rows = page.locator(width === 1440 ? 'tbody tr' : 'li:has(> dl)')
      const geometry = () => rows.evaluateAll(elements => elements.map(element => {
        const { x, y, width, height } = element.getBoundingClientRect()
        return { x, y, width, height }
      }))
      const before = await geometry()
      const measurements = []
      for (const id of [first.id, longId]) {
        const row = rows.filter({ has: page.getByText(id, { exact: true }) })
        await expect(row).toHaveCount(1)
        const text = row.getByText(id, { exact: true })
        await expect(text).toHaveAttribute('title', id)
        const textMetrics = await text.evaluate(element => {
          const range = document.createRange(); range.selectNodeContents(element)
          const style = getComputedStyle(element)
          // Ellipsis can produce multiple rectangles on the same visual line.
          const lineTops = [...new Set(Array.from(range.getClientRects(), rect => rect.top))]
          return { lines: lineTops.length, lineTops, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, whiteSpace: style.whiteSpace, textOverflow: style.textOverflow }
        })
        expect(textMetrics.lines).toBe(1)
        expect(textMetrics.whiteSpace).toBe('nowrap')
        if (id === longId) { expect(textMetrics.textOverflow).toBe('ellipsis'); expect(textMetrics.scrollWidth).toBeGreaterThan(textMetrics.clientWidth) }
        else expect(textMetrics.scrollWidth).toBeLessThanOrEqual(textMetrics.clientWidth)
        const button = row.getByRole('button', { name: copyLabel, exact: true })
        await expect(button).toHaveAttribute('title', copyLabel)
        await expect(button).toHaveText('')
        await expect(button).toHaveAttribute('data-slot', 'button')
        const rowBefore = await row.boundingBox()
        // Exercise keyboard reachability and the shared Button's visible focus ring.
        await page.keyboard.press('Tab'); await button.focus()
        expect(await button.evaluate(element => element.matches(':focus-visible') && getComputedStyle(element).boxShadow !== 'none')).toBe(true)
        await page.keyboard.press('Enter')
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(id)
        await expect(row.getByRole('status')).toHaveText(language === 'cs' ? cs.listIdentifierCopied : en.listIdentifierCopied)
        expect(await row.getByRole('status').evaluate(element => getComputedStyle(element).position)).toBe('absolute')
        const rowAfter = await row.boundingBox()
        expect(rowAfter).toEqual(rowBefore)
        expect(await geometry()).toEqual(before)
        measurements.push({ id, textMetrics, rowBefore, rowAfter })
      }
      expect(errors).toEqual([])
      const path = join(output, `identifier-copy-${language}-${width}.png`)
      await page.screenshot({ path, fullPage: true })
      const bytes = readFileSync(path)
      expect(statSync(path).size).toBeGreaterThan(1000)
      expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
      const decoded = await page.evaluate(async data => {
        const blob = new Blob([Uint8Array.from(atob(data), character => character.charCodeAt(0))], { type: 'image/png' })
        const bitmap = await createImageBitmap(blob)
        const dimensions = { width: bitmap.width, height: bitmap.height }; bitmap.close(); return dimensions
      }, bytes.toString('base64'))
      expect(decoded.width).toBe(width); expect(decoded.height).toBeGreaterThanOrEqual(1000)
      captures.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), decoded, language, viewport: { width, height: 1000 }, mode: width === 1440 ? 'table' : 'cards', measurements, rowsBefore: before, rowsAfter: await geometry(), firstRow: { id: first.id, updated_at: first.updated_at, formatted }, status: queryResponse.status() })
    } finally { await context.close() }
  }
  expect(captures).toHaveLength(4)
  writeFileSync(join(output, 'manifest.json'), JSON.stringify({ head, build, browser: browser.version(), seed: 'list-v2-seed.ts + real POST /api/worker long identifier', authenticatedSession: 'existing synthetic admin session', mockedHTTP: false, instanceCSS: false, captures }, null, 2) + '\n')
})
