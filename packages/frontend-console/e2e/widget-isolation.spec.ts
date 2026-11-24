import { execFileSync } from 'node:child_process'
import { test, expect } from '@playwright/test'
import setup from './runtime/setup'
import { gotoSDK, observeSDKStylesheet } from './list-v2-readiness'
import en from '../src/locales/en.json' with { type: 'json' }
import cs from '../src/locales/cs.json' with { type: 'json' }
let stop: (() => Promise<void>) | undefined
const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const candidate = process.env.WIDGET_CANDIDATE_SHA ?? source
const baseline = process.env.WIDGET_BASELINE === '1'
test.beforeAll(async () => { stop = await setup({ worker: 'widget-worker.ts', seed: 'widget-seed.ts' }) })
test.afterAll(async () => { await stop?.() })
for (const language of ['en', 'cs'] as const) for (const width of [1440, 390]) {
  test(`widget refusal ${language} ${width}`, async ({ page, context }) => {
    const copy = language === 'cs' ? cs : en
    observeSDKStylesheet(page)
    await page.setViewportSize({ width, height: 900 })
    await context.addInitScript(language => localStorage.setItem('console-language', language), language)
    const response = page.waitForResponse(response => response.url().endsWith('/console-pages/summary'))
    await page.goto('/o/org-a/summary')
    expect((await response).status()).toBe(baseline ? 400 : 200)
    if (baseline) await expect(page.getByRole('alert').first()).toHaveText(copy.requestFailed)
    else {
      await expect(page.locator('[data-widget="references"]').getByRole('alert')).toContainText(copy.dashboardWidgetFailed)
      await expect(page.locator('[data-widget="references"]').getByRole('alert')).toContainText('query_too_expensive')
      await expect(page.locator('[data-widget="count"]')).toContainText('1')
      await expect(page.locator('[data-widget="plain"]')).toContainText('Example job')
      await expect(page.getByText('Other job', { exact: true })).toHaveCount(0)
      await expect(page.getByText('Foreign job', { exact: true })).toHaveCount(0)
    }
    await page.evaluate(async () => { await document.fonts.ready })
    await page.screenshot({ path: `${process.env.WIDGET_OUTPUT}/${baseline ? 'base' : 'head'}-${candidate}-${language}-${width}-dashboard.png`, fullPage: true, animations: 'disabled' })
    await gotoSDK(page, '/o/org-a/e/jobs')
    await expect(page.locator('[data-slot="list-page"]')).toBeVisible()
    // The same label expansion is refused on the list too; capture its real error.
    await expect(page.getByRole('alert').first()).toBeVisible()
    await page.screenshot({ path: `${process.env.WIDGET_OUTPUT}/${baseline ? 'base' : 'head'}-${candidate}-${language}-${width}-list.png`, fullPage: true, animations: 'disabled' })
  })
}
