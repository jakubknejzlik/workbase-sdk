import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import setup from './runtime/setup'

let stop: (() => Promise<void>) | undefined
test.beforeAll(async () => { stop = await setup({ worker: 'widget-labels-compat-worker.ts', seed: 'widget-labels-compat-seed.ts' }) })
test.afterAll(async () => { await stop?.() })
for (const englishOnly of [false, true]) for (const language of ['en', 'cs'] as const) for (const width of [1440, 1280, 900, 390]) {
  test(`0.4.0 ${englishOnly ? 'EN-only dictionary' : 'unchanged literal'} ${language} at ${width}px`, async ({ page, request }) => {
    if (englishOnly) expect((await request.post('/__test/widget-labels/en-only', { headers: { Authorization: 'Bearer w29-local-control' } })).ok()).toBe(true)
    expect((await request.get('/health')).status()).toBe(200)
    const model = await request.get('/o/org-a/console-model')
    expect(model.status()).toBe(200)
    expect((await model.json()).console.pages.find((item: { id: string }) => item.id === 'neutral.summary').widgets.map((item: { label: string }) => item.label)).toEqual(['Specimen count', 'Recent specimens'])
    const created = await request.post('/api/specimens', { headers: { 'X-Organization-Id': 'org-a' }, data: { name: 'Alex Example', quantity: 1 } })
    expect(created.status()).toBe(201)
    const record = await created.json() as { id: string }
    try {
      await page.setViewportSize({ width, height: 900 })
      await page.addInitScript(language => localStorage.setItem('console-language', language), language)
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.goto('/o/org-a/summary')
      const count = englishOnly ? 'Localized specimen count' : 'Specimen count'
      await expect(page.locator('[data-widget="count"]').getByRole('heading', { level: 2, name: count, exact: true })).toBeVisible()
      await expect(page.locator('[data-widget="recent"]').getByRole('heading', { level: 2, name: 'Recent specimens', exact: true })).toBeVisible()
      await expect(page.locator('[data-widget="recent"]').getByText('Alex Example', { exact: true }).filter({ visible: true }).first()).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(errors).toEqual([])
      const output = process.env.WIDGET_LABELS_OUTPUT
      if (output) {
        mkdirSync(output, { recursive: true })
        await page.evaluate(async () => { await document.fonts.ready })
        const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
        const name = `${sha}-${englishOnly ? 'en-only' : 'literal'}-${language}-${width}`
        await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true, animations: 'disabled' })
        writeFileSync(resolve(output, `${name}.json`), JSON.stringify({ sha, englishOnly, language, width, errors }, null, 2))
      }
    } finally {
      expect((await request.delete(`/api/specimens/${encodeURIComponent(record.id)}`, { headers: { 'X-Organization-Id': 'org-a' } })).ok()).toBe(true)
    }
  })
}
