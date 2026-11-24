import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import setup from './runtime/setup'

let stop: (() => Promise<void>) | undefined
test.beforeAll(async () => { stop = await setup() })
test.afterAll(async () => { await stop?.() })
const captions = {
  en: { count: 'Specimen count', recent: 'Recent specimens', names: 'Specimen names', fallback: 'Specimens' },
  cs: { count: 'Počet vzorků', recent: 'Nejnovější vzorky', names: 'Názvy vzorků', fallback: 'Vzorky' },
}
for (const language of ['en', 'cs'] as const) for (const width of [1440, 1280, 900, 390]) {
  test(`widget captions ${language} at ${width}px`, async ({ page, request }) => {
    expect((await request.get('/health')).status()).toBe(200)
    // One synthetic row makes both the table and list render their data states.
    const created = await request.post('/api/specimens', { headers: { 'X-Organization-Id': 'org-a' }, data: { name: 'Alex Example', quantity: 1 } })
    expect(created.status()).toBe(201)
    const record = await created.json() as { id: string }
    try {
      await page.setViewportSize({ width, height: 900 })
      await page.addInitScript(language => localStorage.setItem('console-language', language), language)
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.goto('/o/org-a/summary')
      await expect(page.locator('[data-widget="count"]')).toHaveCSS('min-width', '0px')
      await expect(page.locator('[data-widget="count"]')).toHaveCSS('border-style', 'solid')
      for (const [id, caption] of Object.entries(captions[language])) {
        const card = page.locator(`[data-widget="${id}"]`)
        await expect(card.getByRole('heading', { level: 2, name: caption, exact: true })).toBeVisible()
      }
      await expect(page.locator('[data-widget="count"]').getByText('1', { exact: true })).toBeVisible()
      await expect(page.locator('[data-widget="names"]').getByText('Alex Example', { exact: true })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(errors).toEqual([])
      const output = process.env.WIDGET_LABELS_OUTPUT
      if (output) {
        mkdirSync(output, { recursive: true })
        const sha = process.env.WIDGET_LABELS_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
        await page.evaluate(async () => { await document.fonts.ready })
        const geometry = await page.locator('[data-widget] h2').evaluateAll(nodes => nodes.map(node => ({ caption: node.textContent, width: node.clientWidth, scrollWidth: node.scrollWidth })))
        writeFileSync(resolve(output, `${sha}-dictionary-${language}-${width}.json`), JSON.stringify({ sha, language, width, errors, geometry, build: JSON.parse(readFileSync(new URL('../dist/build-meta.json', import.meta.url), 'utf8')) }, null, 2))
        await page.screenshot({ path: resolve(output, `${sha}-dictionary-${language}-${width}.png`), fullPage: true, animations: 'disabled' })
      }
    } finally {
      expect((await request.delete(`/api/specimens/${encodeURIComponent(record.id)}`, { headers: { 'X-Organization-Id': 'org-a' } })).ok()).toBe(true)
    }
  })
}
