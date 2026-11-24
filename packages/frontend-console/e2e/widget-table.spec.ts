import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import setup, { origin } from './runtime/setup'

let stop: (() => Promise<void>) | undefined
test.beforeAll(async () => { stop = await setup({ worker: 'widget-table-worker.ts', seed: 'widget-table-seed.ts' }) })
test.afterAll(async () => { await stop?.() })
const revision = process.env.WIDGET_TABLE_REVISION ?? 'head'
const head = process.env.WIDGET_TABLE_HEAD_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

for (const language of ['en', 'cs']) for (const width of [1440, 1280, 900, 390]) {
  test(`${language} ${width}: widget header and body share tracks and list presentation`, async ({ browser }, info) => {
    const context = await browser.newContext({ baseURL: origin, viewport: { width, height: 1000 }, extraHTTPHeaders: { Authorization: 'Bearer widget-table-owner-session' } })
    await context.addInitScript(language => localStorage.setItem('console-language', language), language)
    try {
      const page = await context.newPage()
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const response = page.waitForResponse(response => response.url().endsWith('/console-pages/neutral.summary'))
      await page.goto('/o/org-a/summary')
      const result = await (await response).json()
      expect(result.widgets.map((widget: { data: unknown[] }) => widget.data.length)).toEqual([3, 3])
      await expect(page.locator('[data-widget="bookings"]').getByRole('link', { name: 'Alex Example', exact: true }).first()).toBeVisible()
      await page.evaluate(async () => { await document.fonts.ready })
      const name = `${revision}-${head}-${language}-${width}`
      await page.screenshot({ path: info.outputPath(`${name}-dashboard.png`), fullPage: true, animations: 'disabled' })
      const geometry = await page.locator('[data-widget]').evaluateAll(widgets => widgets.map(widget => ({
        id: widget.getAttribute('data-widget'),
        tables: Array.from(widget.querySelectorAll('table')).map(table => {
          const cell = (node: Element) => {
            const { x, width } = node.getBoundingClientRect(), style = getComputedStyle(node)
            return { x, width, padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft], align: style.textAlign, fontSize: style.fontSize, lineHeight: style.lineHeight, text: node.textContent }
          }
          return { visible: !!table.getBoundingClientRect().width, headers: Array.from(table.querySelectorAll('thead th'), cell), rows: Array.from(table.querySelectorAll('tbody tr'), row => Array.from(row.querySelectorAll('td'), cell)) }
        }),
      })))
      writeFileSync(info.outputPath(`${name}.json`), JSON.stringify({ geometry, result, browser: browser.version(), build: JSON.parse(readFileSync(new URL('../dist/build-meta.json', import.meta.url), 'utf8')), errors }, null, 2))
      // Baseline capture intentionally records the old renderer, including its mobile cards.
      if (revision !== 'base') {
        for (const widget of geometry) {
          expect(widget.tables).toHaveLength(1)
          const table = widget.tables[0]
          expect(table.visible).toBe(true)
          expect(table.headers).toHaveLength(widget.id === 'bookings' ? 4 : 1)
          expect(table.rows).toHaveLength(3)
          for (const row of table.rows) for (const [index, body] of row.entries()) {
            const header = table.headers[index]
            expect(Math.abs(header.x - body.x), `${widget.id} column ${index} x`).toBeLessThanOrEqual(1)
            expect(Math.abs(header.width - body.width), `${widget.id} column ${index} width`).toBeLessThanOrEqual(1)
            expect(header.padding).toEqual(body.padding)
            expect(header.align).toBe(body.align)
            expect(header.fontSize).toBe(body.fontSize)
          }
        }
        expect(geometry[0].tables[0].headers.map(cell => cell.align)).toEqual(['center', 'center', 'left', 'center'])
        await expect(page.locator('[data-widget] [data-list-density="comfortable"]')).toHaveCount(2)
        await expect(page.locator('[data-widget] button')).toHaveCount(0)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        // The same scroller stays keyboard reachable on narrow viewports.
        const scroller = page.locator('[data-widget="bookings"] [data-slot="table-container"]')
        await scroller.focus()
        await expect(scroller).toBeFocused()
        await page.keyboard.press('End')
        if (width <= 900) expect(await scroller.evaluate(node => node.scrollLeft)).toBeGreaterThan(0)
        await page.keyboard.press('Home')
        expect(await scroller.evaluate(node => node.scrollLeft)).toBe(0)
      }
      await page.goto('/o/org-a/e/specimens')
      const list = page.locator('[data-list-density] table')
      await expect(list).toBeVisible()
      await expect(list.locator('tbody tr')).toHaveCount(3)
      if (revision !== 'base') {
        const reference = await list.locator('tbody td').first().evaluate(node => {
          const style = getComputedStyle(node)
          return { fontSize: style.fontSize, lineHeight: style.lineHeight, padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft] }
        })
        const cell = geometry[0].tables[0].rows[0][0]
        expect({ fontSize: cell.fontSize, lineHeight: cell.lineHeight, padding: cell.padding }).toEqual(reference)
      }
      await page.screenshot({ path: info.outputPath(`${name}-list.png`), fullPage: true, animations: 'disabled' })
      expect(errors).toEqual([])
    } finally { await context.close() }
  })
}
