import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import setup, { origin } from './runtime/setup'
import en from '../src/locales/en.json' with { type: 'json' }
import cs from '../src/locales/cs.json' with { type: 'json' }

let stop: (() => Promise<void>) | undefined
test.beforeAll(async ({ browser }) => {
  stop = await setup({ worker: 'stat-widget-worker.ts', seed: 'seed.ts' })
  const context = await browser.newContext({ baseURL: origin, extraHTTPHeaders: { Authorization: 'Bearer w29-owner-session' } })
  try {
    const page = await context.newPage()
    await page.goto('/o/org-a/e/specimens')
    await page.getByRole('button', { name: 'Add record', exact: true }).click()
    const create = page.getByRole('dialog')
    await create.getByLabel('Name', { exact: true }).fill('Alex Example')
    await create.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(create).toBeHidden()
  } finally { await context.close() }
})
test.afterAll(async () => { await stop?.() })

for (const language of ['en', 'cs'] as const) for (const width of [1440, 390]) {
  test(`${language} ${width}: zero, nonzero and missing stats share a card height`, async ({ browser }, info) => {
    const copy = language === 'cs' ? cs : en
    const context = await browser.newContext({ baseURL: origin, viewport: { width, height: 900 }, extraHTTPHeaders: { Authorization: 'Bearer w29-owner-session' } })
    await context.addInitScript(language => localStorage.setItem('console-language', language), language)
    try {
      const page = await context.newPage()
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const response = page.waitForResponse(response => response.url().endsWith('/console-pages/neutral.summary'))
      await page.goto('/o/org-a/summary')
      const result = await (await response).json()
      expect(result.widgets.map(({ id, value }: { id: string; value: unknown }) => [id, value])).toEqual([['zero', 0], ['nonzero', 1], ['missing', null]])
      const cards = page.locator('[data-detail-row] [data-widget]')
      await expect(cards).toHaveCount(3)
      await expect(page.locator('[data-widget="nonzero"]')).toContainText('1')
      await page.evaluate(async () => { await document.fonts.ready })
      const geometry = await cards.evaluateAll(nodes => nodes.map(node => {
        const { x, y, width, height } = node.getBoundingClientRect()
        return { id: node.getAttribute('data-widget'), x, y, width, height, text: node.textContent }
      }))
      const head = process.env.STAT_WIDGET_HEAD_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
      const name = `${process.env.STAT_WIDGET_REVISION ?? 'head'}-${head}-${language}-${width}`
      await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true, animations: 'disabled' })
      writeFileSync(info.outputPath(`${name}.json`), JSON.stringify({ geometry, result, build: JSON.parse(readFileSync(new URL('../dist/build-meta.json', import.meta.url), 'utf8')), browser: browser.version(), errors }, null, 2))
      await expect(page.locator('[data-widget="zero"]').getByText('0', { exact: true })).toBeVisible()
      await expect(page.locator('[data-widget="zero"]')).not.toContainText(copy.dashboardEmpty)
      await expect(page.locator('[data-widget="missing"]')).toContainText(copy.dashboardEmpty)
      expect(new Set(geometry.map(card => card.height)).size, JSON.stringify(geometry)).toBe(1)
      if (width === 1440) expect(new Set(geometry.map(card => card.y)).size).toBe(1)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(errors).toEqual([])
    } finally { await context.close() }
  })
}
