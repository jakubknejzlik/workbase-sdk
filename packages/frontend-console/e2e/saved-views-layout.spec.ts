import { test, expect, type Locator, type Page } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import setup, { origin } from './runtime/setup'
import en from '../src/locales/en.json' with { type: 'json' }
import cs from '../src/locales/cs.json' with { type: 'json' }

let stop: (() => Promise<void>) | undefined
test.beforeAll(async () => { stop = await setup({ worker: 'saved-views-layout-worker.ts', seed: 'application-access-seed.ts' }) })
test.afterAll(async () => { await stop?.() })

async function box(locator: Locator) {
  const bounds = await locator.boundingBox()
  expect(bounds).not.toBeNull()
  return bounds!
}

async function geometry(page: Page, section: Locator) {
  await page.evaluate(() => window.scrollTo(0, 0))
  await expect.poll(() => page.evaluate(() => [scrollX, scrollY])).toEqual([0, 0])
  const header = await box(page.locator('header'))
  const savedViews = await box(section)
  expect.soft(header.y + header.height, 'header ends before saved views at scroll zero').toBeLessThanOrEqual(savedViews.y)
  for (const crumb of await page.locator('[data-slot="breadcrumb"] li').all()) {
    const bounds = await box(crumb)
    expect.soft(bounds.y, 'breadcrumb top inside header').toBeGreaterThanOrEqual(header.y)
    expect.soft(bounds.y + bounds.height, 'breadcrumb bottom inside header').toBeLessThanOrEqual(header.y + header.height)
    expect.soft(bounds.x, 'breadcrumb left inside header').toBeGreaterThanOrEqual(header.x)
    expect.soft(bounds.x + bounds.width, 'breadcrumb right inside header').toBeLessThanOrEqual(header.x + header.width)
  }
  const controls = []
  for (const control of await section.locator('select, input, button, form, label').all()) {
    const bounds = await box(control)
    controls.push(bounds)
    if (await control.evaluate(node => node.matches('select, label'))) expect.soft(bounds.width, 'saved-view fields have a bounded width').toBeLessThanOrEqual(320)
    expect.soft(bounds.x, 'saved-view control left inside section').toBeGreaterThanOrEqual(savedViews.x)
    expect.soft(bounds.x + bounds.width, 'saved-view control right inside section').toBeLessThanOrEqual(savedViews.x + savedViews.width + 1)
    expect.soft(bounds.x + bounds.width, 'saved-view control right inside viewport').toBeLessThanOrEqual(page.viewportSize()!.width)
  }
  expect.soft(await page.evaluate(() => document.documentElement.scrollWidth), 'no page horizontal overflow').toBeLessThanOrEqual(page.viewportSize()!.width)
  return { scroll: { x: 0, y: 0 }, header, savedViews, controls }
}

async function reachable(page: Page, control: Locator) {
  await control.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'nearest' }))
  await control.focus()
  await expect(control).toBeFocused()
  await expect(control).toBeInViewport({ ratio: 1 })
  const header = await box(page.locator('header'))
  const bounds = await box(control)
  expect.soft(header.y, 'header remains sticky after scrolling').toBe(0)
  expect.soft(bounds.y, 'focused control is below the sticky header').toBeGreaterThanOrEqual(header.y + header.height)
}

for (const language of ['en', 'cs'] as const) for (const width of [390, 1440]) {
  test(`${language} ${width}: wrapping shell and the saved-views menu, save and rename stay contained`, async ({ browser }, testInfo) => {
    const t = language === 'cs' ? cs : en
    const context = await browser.newContext({ baseURL: origin, viewport: { width, height: 540 }, extraHTTPHeaders: { Authorization: 'Bearer access-admin-session' } })
    await context.addInitScript(lang => localStorage.setItem('console-language', lang), language)
    const page = await context.newPage()
    const longName = `${language === 'cs' ? 'Dlouhý osobní pohled' : 'Long personal saved view'} ${'W'.repeat(40)}`
    const measurements: ({ state: string } & Awaited<ReturnType<typeof geometry>>)[] = []
    try {
      await page.goto('/o/org-a/e/worker')
      await expect(page.getByRole('link', { name: 'No account', exact: true })).toBeVisible()
      await expect(page.locator('[data-slot="breadcrumb"]')).toContainText('Synthetic saved view navigation')
      const section = page.getByRole('region', { name: t.savedViews, exact: true })
      const trigger = section.locator('button[aria-haspopup="dialog"]')
      const menu = page.getByRole('dialog', { name: t.savedViews, exact: true })
      const naming = page.getByRole('dialog').filter({ has: page.getByRole('textbox', { name: t.savedViewsName, exact: true }) })
      const input = naming.getByRole('textbox', { name: t.savedViewsName, exact: true })
      const confirm = naming.getByRole('button', { name: t.savedViewsConfirm, exact: true })
      const shot = async (state: string) => {
        measurements.push({ state, ...await geometry(page, section) })
        await page.screenshot({ path: testInfo.outputPath(`${language}-${width}-${state}.png`), animations: 'disabled', fullPage: true })
      }
      const open = async () => { if (!await menu.isVisible()) await trigger.click(); await expect(menu).toBeVisible() }
      const item = async (name: string) => { await open(); await menu.getByRole('button', { name, exact: true }).click() }

      // Create through the real menu and dialog, then keep a long view name present in every acceptance capture.
      await item(t.savedViewsSaveNew)
      await expect(input).toBeFocused()
      await input.fill(longName)
      await confirm.click()
      await expect(trigger).toContainText(longName)
      await expect(trigger).toBeFocused()
      await shot('selected')
      await open()
      await expect(menu.getByRole('button', { name: longName, exact: true })).toHaveAttribute('aria-pressed', 'true')
      await menu.getByRole('button', { name: t.savedViewsApplyView, exact: true }).click()
      await expect(trigger).toBeFocused()

      await item(t.savedViewsSaveNew)
      await expect(input).toBeFocused()
      await input.fill(`${longName} second`)
      await shot('save')
      await reachable(page, input)
      await page.keyboard.press('Tab')
      await expect(confirm).toBeFocused()
      await reachable(page, confirm)
      await naming.getByRole('button', { name: t.cancel, exact: true }).click()
      await expect(trigger).toBeFocused()

      await item(t.savedViewsRenameThis)
      await expect(input).toBeFocused()
      await expect(input).toHaveValue(longName)
      await input.fill(`${longName} renamed`)
      await shot('rename')
      await reachable(page, input)
      await confirm.click()
      await expect(trigger).toContainText(`${longName} renamed`)

      // Distinguish intentional sticky-header overlay after scrolling from scroll-zero layout.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
      expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0)
      for (const control of await section.locator('button').all()) await reachable(page, control)
      await shot('renamed')
      await item(t.savedViewsDeleteThis)
      await page.getByRole('dialog').getByRole('button', { name: t.savedViewsDelete, exact: true }).click()
      await expect(trigger).toHaveText(t.savedViewsMenu)
      await expect(trigger).toBeFocused()
    } finally {
      const path = testInfo.outputPath('geometry.json')
      await writeFile(path, JSON.stringify(measurements, null, 2))
      await testInfo.attach('geometry', { path, contentType: 'application/json' })
      await context.close()
    }
  })
}
