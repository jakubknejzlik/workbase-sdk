import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import setup from './runtime/setup'

let stop: (() => Promise<void>) | undefined
let id: string
test.beforeAll(async ({ request }) => {
  stop = await setup()
  const response = await request.post('/api/specimens', { headers: { 'X-Organization-Id': 'org-a' }, data: { name: 'Alex Example', quantity: 3 } })
  expect(response.ok()).toBe(true)
  id = (await response.json()).id
  const result = await request.get('/o/org-a/console-pages/neutral.summary')
  expect(result.ok()).toBe(true)
  const withoutId = (await result.json()).widgets.find((widget: { id: string }) => widget.id === 'names-without-id')
  expect(withoutId.data).toEqual([{ name: 'Alex Example' }])
})
test.afterAll(async () => { await stop?.() })
for (const width of [1440, 390]) test(`dashboard table/list keyboard drilldown at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 })
  await page.addInitScript(() => localStorage.setItem('console-language', 'en'))
  const stylesheet = page.waitForResponse(response => /\/assets\/index-[^/]+\.css$/.test(new URL(response.url()).pathname))
  await page.goto('/o/org-a/summary')
  expect((await stylesheet).ok()).toBe(true)
  const table = page.locator('[data-widget="recent"]')
  const list = page.locator('[data-widget="names"]')
  const withoutId = page.locator('[data-widget="names-without-id"]')
  await expect(table.getByText('Alex Example', { exact: true }).filter({ visible: true })).toBeVisible()
  await expect(list.getByText('Alex Example', { exact: true })).toBeVisible()
  await expect(table.locator(width === 390 ? '.generated-relation-cards' : '.generated-relation-table')).toBeVisible()
  await expect(table.locator(width === 390 ? '.generated-relation-table' : '.generated-relation-cards')).toBeHidden()
  await page.evaluate(async () => { await document.fonts.ready })
  await expect(withoutId.getByRole('link')).toHaveCount(0)
  if (process.env.WIDGET_DRILLDOWN_OUTPUT) {
    mkdirSync(process.env.WIDGET_DRILLDOWN_OUTPUT, { recursive: true })
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    await page.screenshot({ path: `${process.env.WIDGET_DRILLDOWN_OUTPUT}/${process.env.WIDGET_DRILLDOWN_PHASE ?? 'head'}-${sha}-en-${width}.png`, fullPage: true })
  }
  if (process.env.WIDGET_DRILLDOWN_PHASE === 'base') return
  for (const widget of [table, list]) {
    const link = widget.getByRole('link', { name: 'Alex Example', exact: true }).filter({ visible: true })
    await expect(link).toHaveAttribute('href', `/o/org-a/e/specimens/${id}`)
    // Reach the native link through the keyboard, then activate it with Enter.
    for (let step = 0; step < 30 && !await link.evaluate(node => node === document.activeElement); step++) await page.keyboard.press('Tab')
    await expect(link).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(new RegExp(`/o/org-a/e/specimens/${id}$`))
    await expect(page.getByRole('heading', { level: 1, name: 'Alex Example', exact: true })).toBeVisible()
    await page.goto('/o/org-a/summary')
  }
})
