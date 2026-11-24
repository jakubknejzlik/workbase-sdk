import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import setup from './runtime/setup'

let stop: (() => Promise<void>) | undefined
test.beforeAll(async () => { stop = await setup() })
test.afterAll(async () => { await stop?.() })
const captions = {
  en: { count: 'Specimen count', recent: 'Recent specimens', names: 'Specimen names', fallback: 'Specimens' },
  cs: { count: 'Počet vzorků', recent: 'Nejnovější vzorky', names: 'Názvy vzorků', fallback: 'Vzorky' },
}
for (const language of ['en', 'cs'] as const) for (const width of [1440, 390]) {
  test(`widget captions ${language} at ${width}px`, async ({ page, request }) => {
    // One synthetic row makes both the table and list render their data states.
    const created = await request.post('/api/specimens', { headers: { 'X-Organization-Id': 'org-a' }, data: { name: 'Alex Example', quantity: 1 } })
    expect(created.status()).toBe(201)
    const record = await created.json() as { id: string }
    try {
      await page.setViewportSize({ width, height: 900 })
      await page.addInitScript(language => localStorage.setItem('console-language', language), language)
      await page.goto('/o/org-a/summary')
      await expect(page.locator('[data-widget="count"]')).toHaveCSS('min-width', '0px')
      await expect(page.locator('[data-widget="count"]')).toHaveCSS('border-style', 'solid')
      const baseline = process.env.WIDGET_LABELS_BASE === '1'
      for (const [id, caption] of Object.entries(captions[language])) {
        const card = page.locator(`[data-widget="${id}"]`)
        const baseCaptions = { count: 'Dashboard specimen count', recent: 'Dashboard recent specimens', names: 'Dashboard specimen names', fallback: caption }
        await expect(card.getByRole('heading', { level: 2, name: baseline ? baseCaptions[id as keyof typeof baseCaptions] : caption, exact: true })).toBeVisible()
      }
      await expect(page.locator('[data-widget="count"]').getByText('1', { exact: true })).toBeVisible()
      await expect(page.locator('[data-widget="names"]').getByText('Alex Example', { exact: true })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      const output = process.env.WIDGET_LABELS_OUTPUT
      if (output) {
        mkdirSync(output, { recursive: true })
        const sha = process.env.WIDGET_LABELS_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
        await page.evaluate(async () => { await document.fonts.ready })
        await page.screenshot({ path: resolve(output, `${sha}-${baseline ? 'base' : 'head'}-${language}-${width}.png`), fullPage: true, animations: 'disabled' })
      }
    } finally {
      expect((await request.delete(`/api/specimens/${encodeURIComponent(record.id)}`, { headers: { 'X-Organization-Id': 'org-a' } })).ok()).toBe(true)
    }
  })
}
