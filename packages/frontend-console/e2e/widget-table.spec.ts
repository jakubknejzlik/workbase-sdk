import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import setup, { origin } from './runtime/setup'
import AxeBuilder from '@axe-core/playwright'
import { join } from 'node:path'

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
      expect(result.widgets.filter((widget: { kind: string }) => widget.kind !== 'stat').map((widget: { data: unknown[] }) => widget.data.length)).toEqual([3, 3])
      expect(await page.locator('[data-widget]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-widget')))).toEqual(['bookings', 'clients', 'count'])
      await expect(page.locator('[data-widget="bookings"]').getByRole('link', { name: 'Alex Example', exact: true }).first()).toBeVisible()
      await page.evaluate(async () => { await document.fonts.ready })
      const name = `${revision}-${head}-${language}-${width}`
      await page.screenshot({ path: info.outputPath(`${name}-dashboard.png`), fullPage: true, animations: 'disabled' })
      const geometry = await page.locator('[data-widget]:has(table)').evaluateAll(widgets => widgets.map(widget => ({
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
      const layout = await page.locator('[data-widget]').evaluateAll(nodes => nodes.map(node => {
        const rect = node.getBoundingClientRect()
        const header = node.querySelector('[data-slot="card-header"]')!
        const title = node.querySelector('h2')!
        return { id: node.getAttribute('data-widget'), x: rect.x, y: rect.y, width: rect.width, bottom: rect.bottom,
          titleFits: title.scrollWidth <= title.clientWidth, headerPadding: getComputedStyle(header).padding }
      }))
      expect(layout[2].y).toBeGreaterThanOrEqual(Math.max(layout[0].bottom, layout[1].bottom))
      expect(layout.every(card => card.titleFits)).toBe(true)
      expect(layout[0].headerPadding).toBe(width <= 680 ? '18px' : '21px 22px')
      expect(await page.evaluate(() => document.fonts.check('16px Alata', 'Příliš žluťoučký kůň'))).toBe(true)
      const font = await page.locator('[data-widget] h2').first().evaluate(node => ({ family: getComputedStyle(node).fontFamily, weight: getComputedStyle(node).fontWeight, synthesis: getComputedStyle(node).fontSynthesis }))
      expect(font.family).toContain('Alata')
      expect(font.weight).toBe('400')
      expect(font.synthesis).toBe('none')
      const fontRequests = await page.evaluate(() => performance.getEntriesByType('resource').map(item => item.name).filter(name => /font|\.ttf|\.woff/i.test(name)))
      expect(fontRequests.some(url => url.startsWith(origin) && /Alata.*\.ttf/.test(url))).toBe(true)
      expect(fontRequests.some(url => /fonts\.(googleapis|gstatic)\.com/.test(url))).toBe(false)
      writeFileSync(info.outputPath(`${name}-layout.json`), JSON.stringify({ layout, font, fontRequests, csp: (await page.request.get('/o/org-a/summary')).headers()['content-security-policy'] }, null, 2))
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
      for (const state of ['default', 'isolated']) {
        const response = page.waitForResponse(response => response.url().endsWith(`/console-pages/neutral.${state}`))
        await page.goto(`/o/org-a/${state}`)
        const body = await (await response).json()
        await expect(page.locator('[data-widget="count"]')).toContainText('3')
        await expect(page.locator('[data-widget="bookings"] table tbody tr')).toHaveCount(3)
        if (state === 'default') {
          expect(await page.locator('[data-widget]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-widget')))).toEqual(['count', 'bookings', 'clients'])
          await expect(page.getByRole('alert')).toHaveCount(0)
        } else {
          expect(body.widgets.find((widget: { id: string }) => widget.id === 'unavailable')).toMatchObject({ kind: 'error', code: 'widget_failed' })
          await expect(page.locator('[data-widget="unavailable"]').getByRole('alert')).toBeVisible()
          expect(await page.locator('[data-widget]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-widget')))).toEqual(['bookings', 'clients', 'count', 'unavailable'])
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.evaluate(async () => { await document.fonts.ready })
        await page.screenshot({ path: info.outputPath(`${name}-${state}-dashboard.png`), fullPage: true, animations: 'disabled' })
        writeFileSync(info.outputPath(`${name}-${state}.json`), JSON.stringify(body, null, 2))
      }
      expect(errors).toEqual([])
    } finally { await context.close() }
  })
}

for (const language of ['en', 'cs']) for (const width of [1440, 1280, 900, 390]) {
  test(`E3 actions ${language} ${width}: real forms, navigation, denial and whole-page states`, async ({ browser }, info) => {
    test.setTimeout(120_000)
    const context = await browser.newContext({ baseURL: origin, viewport: { width, height: 1000 }, extraHTTPHeaders: { Authorization: 'Bearer widget-table-owner-session' } })
    await context.addInitScript(language => localStorage.setItem('console-language', language), language)
    const page = await context.newPage(), errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const region = page.getByRole('region', { name: language === 'cs' ? 'Rychlé akce' : 'Quick actions' })
    const capture = async (state: string) => {
      await page.evaluate(async () => { await document.fonts.ready })
      const name = `dashboard-${width}-${language}-${state}-${head}.png`
      await page.screenshot({ path: process.env.E3_CAPTURE_DIR ? join(process.env.E3_CAPTURE_DIR, name) : info.outputPath(name), fullPage: true, animations: 'disabled' })
    }
    const create = language === 'cs' ? 'Vytvořit vzorek' : 'Create specimen'
    const register = language === 'cs' ? 'Zaregistrovat klienta' : 'Register client'
    const processLabel = language === 'cs' ? 'Zpracovat vzorky' : 'Process specimens'
    const browse = language === 'cs' ? 'Procházet vzorky' : 'Browse specimens'
    try {
      for (const [state, count] of [['zero', 0], ['one', 1], ['multiple', 4], ['long', 4], ['denied', 0]] as const) {
        await page.goto(`/o/org-a/actions-${state}`)
        await expect(page.locator('[data-widget="count"]')).toBeVisible()
        if (!count) await expect(region).toHaveCount(0)
        else {
          await expect(region.locator('.dashboard-action')).toHaveCount(count)
          await expect(region.locator('button').first()).toBeEnabled()
          expect(await region.locator('button button, a button, button a, a a').count()).toBe(0)
          const geometry = await region.locator('.dashboard-action').evaluateAll(nodes => nodes.map(node => {
            const rect = node.getBoundingClientRect(), icon = node.querySelector('svg')!.getBoundingClientRect(), badge = node.querySelector('.dashboard-action-icon')!.getBoundingClientRect(), title = node.querySelector('.dashboard-action-copy') as HTMLElement
            return { x: rect.x, width: rect.width, fits: node.scrollWidth <= node.clientWidth && title.scrollWidth <= title.clientWidth, iconWidth: icon.width, iconHeight: icon.height,
              centered: Math.abs(icon.x + icon.width / 2 - badge.x - badge.width / 2) < 1 && Math.abs(icon.y + icon.height / 2 - badge.y - badge.height / 2) < 1 }
          }))
          expect(geometry.every(card => card.fits && card.centered && card.iconWidth === 24 && card.iconHeight === 24)).toBe(true)
          expect(new Set(geometry.map(card => Math.round(card.x))).size).toBe(count > 1 && width > 680 ? 2 : 1)
          const priority = await page.locator('.dashboard-priority').evaluate(node => {
            const action = node.querySelector('.dashboard-actions')!.getBoundingClientRect(), widget = node.querySelector('[data-widget]')!.getBoundingClientRect()
            return { action: { x: action.x, y: action.y, bottom: action.bottom }, widget: { x: widget.x, y: widget.y } }
          })
          expect(priority.action.y).toBeLessThanOrEqual(priority.widget.y)
          if (width === 390) expect(priority.widget.y).toBeGreaterThanOrEqual(priority.action.bottom)
          writeFileSync(info.outputPath(`${language}-${width}-${state}-actions.json`), JSON.stringify({ geometry, priority }, null, 2))
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
        await capture(state)
      }
      await page.goto('/o/org-a/actions-multiple')
      await expect(region.getByRole('button', { name: create, exact: false })).toBeEnabled()
      // The header and card use the same descriptor and both reach the same form.
      await page.getByRole('button', { name: create, exact: true }).first().click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByRole('textbox').first()).toBeVisible()
      await dialog.getByRole('button', { name: language === 'cs' ? 'Zrušit' : 'Cancel', exact: true }).click()
      await expect(page.getByRole('button', { name: create, exact: true }).first()).toBeFocused()
      const trigger = region.getByRole('button', { name: create, exact: false })
      await trigger.focus(); await page.keyboard.press('Enter')
      await expect(dialog).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(trigger).toBeFocused()
      for (const [label, path] of [[create, '/api/specimens'], [register, '/commands/clients/register'], [processLabel, '/commands/specimens/process']]) {
        await region.getByRole('button', { name: label, exact: false }).click()
        await expect(dialog).toBeVisible()
        // Fill only visible generated controls; actual API validation and mutation run in D1.
        await dialog.getByRole('textbox').first().fill(`E3 ${language} ${width}`)
        const response = page.waitForResponse(response => response.url().endsWith(path) && response.request().method() === 'POST')
        await dialog.locator('button[type="submit"]').click()
        expect((await response).ok()).toBe(true)
        // Completion includes the real dashboard and generated-form cache reads.
        await expect(dialog).toHaveCount(0, { timeout: 20_000 })
        await expect(region.getByRole('button', { name: label, exact: false })).toBeFocused({ timeout: 10_000 })
      }
      await region.getByRole('button', { name: processLabel, exact: false }).click()
      await dialog.getByRole('textbox').first().fill('fail')
      const failure = page.waitForResponse(response => response.url().endsWith('/commands/specimens/process') && response.request().method() === 'POST')
      await dialog.locator('button[type="submit"]').click()
      expect((await failure).ok()).toBe(false)
      await expect(dialog.getByRole('alert')).toBeVisible()
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
      await capture('failed-submit')
      await page.keyboard.press('Escape')
      // A dirty failed form uses the existing discard confirmation before navigation.
      await dialog.locator('[data-slot="discard-prompt"] button').last().click()
      await expect(dialog).toHaveCount(0)
      await region.getByRole('link', { name: browse, exact: false }).click()
      await expect(page).toHaveURL(/\/o\/org-a\/e\/specimens$/)
      expect(errors).toEqual([])
    } finally { await context.close() }
  })
}
