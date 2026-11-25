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

const output = process.env.METADATA_LIST_CAPTURES ?? join(tmpdir(), 'metadata-list-captures')
let stop: (() => Promise<void>) | undefined
test.beforeAll(async () => { stop = await setup({ worker: 'metadata-list-worker.ts', seed: 'list-v2-seed.ts' }) })
test.afterAll(async () => { await stop?.() })

test('real authorized metadata cells at 1440/390 in EN/CS', async ({ browser }) => {
  mkdirSync(output, { recursive: true })
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const build = JSON.parse(readFileSync(resolve(import.meta.dirname, '../dist/build-meta.json'), 'utf8'))
  expect(build.sourceCommit).toBe(head)
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
      await surface.getByRole('button', { name: copyLabel, exact: true }).click()
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(first.id)
      await expect(surface.getByRole('status')).toHaveText(language === 'cs' ? cs.listIdentifierCopied : en.listIdentifierCopied)
      await page.evaluate(async () => { await document.fonts.ready })
      expect(errors).toEqual([])
      const path = join(output, `metadata-${language}-${width}.png`)
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
      captures.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), decoded, language, viewport: { width, height: 1000 }, firstRow: { id: first.id, updated_at: first.updated_at, formatted }, status: queryResponse.status() })
    } finally { await context.close() }
  }
  expect(captures).toHaveLength(4)
  writeFileSync(join(output, 'manifest.json'), JSON.stringify({ head, build, browser: browser.version(), seed: 'list-v2-seed.ts', authenticatedSession: 'existing synthetic admin session', mockedHTTP: false, instanceCSS: false, captures }, null, 2) + '\n')
})
