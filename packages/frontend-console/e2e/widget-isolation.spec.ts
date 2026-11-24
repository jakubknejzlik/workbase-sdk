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
const codes = baseline ? ['query_too_expensive'] : ['query_too_expensive', 'widget_failed', 'future_error']
test.beforeAll(async () => { stop = await setup({ worker: 'widget-worker.ts', seed: 'widget-seed.ts' }) })
test.afterAll(async () => { await stop?.() })
for (const language of ['en', 'cs'] as const) for (const width of [1440, 390]) for (const code of codes) {
  test(`widget refusal ${language} ${width} ${code}`, async ({ page, context }) => {
    const copy = language === 'cs' ? cs : en
    observeSDKStylesheet(page)
    await page.setViewportSize({ width, height: 900 })
    await context.addInitScript(language => localStorage.setItem('console-language', language), language)
    if (code !== 'query_too_expensive') await page.route('**/console-pages/summary', async route => {
      const response = await route.fetch()
      const body = await response.json()
      const refused = body.widgets.find((widget: { id: string }) => widget.id === 'references')
      expect(refused).toEqual({ id: 'references', label: 'Recent jobs', kind: 'error', code: 'query_too_expensive' })
      // Exercise generic/future-code presentation while retaining the real healthy widgets.
      refused.code = code
      await route.fulfill({ response, json: body })
    })
    const response = page.waitForResponse(response => response.url().endsWith('/console-pages/summary'))
    await page.goto('/o/org-a/summary')
    const dashboardResponse = await response
    expect(dashboardResponse.status()).toBe(baseline ? 400 : 200)
    if (baseline) await expect(page.getByRole('alert').first()).toHaveText(copy.requestFailed)
    else {
      const body = await dashboardResponse.json()
      expect(body.widgets).toContainEqual({ id: 'references', label: 'Recent jobs', kind: 'error', code })
      const alert = page.locator('[data-widget="references"]').getByRole('alert')
      await expect(alert).toContainText(copy.dashboardWidgetFailed)
      await expect(alert).toContainText(code === 'query_too_expensive' ? copy.dashboardWidgetTooComplex : copy.dashboardWidgetRetry)
      await expect(alert).toHaveAttribute('data-error-code', code)
      await expect(page.locator('body')).not.toContainText(/query_too_expensive|widget_failed|future_error/)
      await expect(page.locator('[data-widget="count"]')).toContainText('1')
      await expect(page.locator('[data-widget="plain"]')).toContainText('Example job')
      await expect(page.getByText('Other job', { exact: true })).toHaveCount(0)
      await expect(page.getByText('Foreign job', { exact: true })).toHaveCount(0)
    }
    await page.evaluate(async () => { await document.fonts.ready })
    const capture = `${process.env.WIDGET_OUTPUT}/${baseline ? 'base' : 'head'}-${candidate}-${language}-${width}-${code}`
    await page.screenshot({ path: `${capture}-dashboard.png`, fullPage: true, animations: 'disabled' })
    if (!baseline) await page.locator('[data-widget="references"]').screenshot({ path: `${capture}-card.png`, animations: 'disabled' })
    await gotoSDK(page, '/o/org-a/e/jobs')
    await expect(page.locator('[data-slot="list-page"]')).toBeVisible()
    // The same label expansion is refused on the list too; capture its real error.
    await expect(page.getByRole('alert').first()).toBeVisible()
    await page.screenshot({ path: `${capture}-list.png`, fullPage: true, animations: 'disabled' })
  })
}
