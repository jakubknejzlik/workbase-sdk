import { expect, type Page } from '@playwright/test'

const responses = new WeakMap<Page, Map<string, number>>()
const sdkAsset = (url: string) => /\/assets\/index-[^/]+\.css$/.test(new URL(url).pathname)

export function observeSDKStylesheet(page: Page) {
  if (responses.has(page)) return
  const statuses = new Map<string, number>()
  responses.set(page, statuses)
  page.on('request', request => { if (sdkAsset(request.url())) statuses.delete(request.url()) })
  page.on('response', response => { if (sdkAsset(response.url())) statuses.set(response.url(), response.status()) })
}

export async function sdkStylesheetReady(page: Page) {
  const links = await page.locator('link[rel="stylesheet"]').evaluateAll(elements => elements.map(element => (element as HTMLLinkElement).href))
  const sdkLinks = links.filter(sdkAsset)
  const statuses = sdkLinks.map(url => ({ url, status: responses.get(page)?.get(url) ?? 'missing response' }))
  expect(sdkLinks.length, 'SDK stylesheet readiness: missing real SDK stylesheet link').toBeGreaterThan(0)
  expect(statuses.every(({ status }) => typeof status === 'number' && status >= 200 && status < 300),
    `SDK stylesheet readiness: stylesheet response must succeed: ${JSON.stringify(statuses)}`).toBe(true)
  await expect.poll(() => page.evaluate(urls => {
    const element = document.querySelector('[data-slot="list-page"]')
    if (!element || !urls.every(url => Array.from(document.styleSheets).some(sheet => sheet.href === url))) return false
    // The SDK list container uses min-w-0 and overflow-hidden. UA styles do not.
    const style = getComputedStyle(element)
    return style.minWidth === '0px' && style.overflowX === 'hidden' && style.overflowY === 'hidden'
  }, sdkLinks), { message: 'SDK stylesheet readiness: SDK list styles must be loaded and applied before visual/geometry assertions' }).toBe(true)
}

export async function gotoSDK(page: Page, url: string) {
  observeSDKStylesheet(page)
  const response = await page.goto(url)
  await sdkStylesheetReady(page)
  return response
}

export async function reloadSDK(page: Page) {
  observeSDKStylesheet(page)
  const response = await page.reload()
  await sdkStylesheetReady(page)
  return response
}
