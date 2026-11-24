import { execFileSync } from 'node:child_process'
const provenanceSHA = () => execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
import { test, expect, type Page, type Locator, type CDPSession } from '@playwright/test'
import setup from './runtime/setup'
import { observePreview500, assertNoPreview500 } from './list-v2-http'
import { observeSDKStylesheet, sdkStylesheetReady, gotoSDK, reloadSDK } from './list-v2-readiness'
import { layoutDiagnostics, attachLayoutDiagnostics } from './list-v2-layout-diagnostics'
import { workers, expectedRows, expectedCounts, type Selection } from './runtime/list-v2-data'
import { capture, captureSDK, provenance, result, record, output } from './list-v2-evidence'
import en from '../src/locales/en.json' with { type: 'json' }
import cs from '../src/locales/cs.json' with { type: 'json' }

let observations: unknown[] = []
let stop: (() => Promise<void>) | undefined
const route = '/o/org-a/e/worker'
const labels: Record<string, string> = { all: 'All workers', active: 'Active workers', inactive: 'Inactive workers', empty: 'Archived workers', invited: 'Pending invitations' }
test.beforeAll(async ({ browser }) => { stop = await setup({ worker: 'list-v2-worker.ts', seed: 'list-v2-seed.ts' }); provenance(browser.version()) })
test.afterAll(async () => { await stop?.() })
test.beforeEach(async ({ context, page }) => { observations = []; observeSDKStylesheet(page); observePreview500(context); page.on('response', response => { if (new URL(response.url()).pathname === '/query') void response.json().then(body => observations.push({ kind: 'query', request: response.request().postDataJSON(), status: response.status(), response: body })).catch(() => {}) }); await context.addInitScript(() => localStorage.setItem('console-language', 'en')) })
test.afterEach(async ({ page, context }, info) => { observations.push({ kind: 'final', url: page.url(), ids: await ids(page).catch(() => []), footer: await footer(page).textContent().catch(() => null), tabs: await list(page).locator('[data-list-slot="tabs"]').textContent().catch(() => null) }); record('functionalEvidence', info.title, observations); try { await assertNoPreview500(context, info); result(info) } catch (error) { result(info, error); throw error } })
const list = (page: Page) => page.locator('[data-slot="list-page"]')
const footer = (page: Page) => list(page).locator('footer')
const panel = (page: Page) => page.getByRole('group', { name: en.sortAndFilter, exact: true })
const savedTrigger = (page: Page) => page.getByRole('region', { name: en.savedViews, exact: true }).locator('button[aria-haspopup="dialog"]')
const savedMenu = (page: Page) => page.getByRole('dialog', { name: en.savedViews, exact: true })
async function settled(page: Page) {
  await sdkStylesheetReady(page)
  await expect(list(page)).toBeVisible()
  await expect(list(page).getByText(en.loading, { exact: true })).toHaveCount(0)
  await expect(list(page).getByText(en.rowAccessRefreshing, { exact: true })).toHaveCount(0)
  await expect(footer(page).locator('[data-list-range]')).toBeVisible()
  await page.evaluate(async () => { await document.fonts.ready })
}
async function ids(page: Page) {
  return page.locator(`table a[href^="${route}/"]`).evaluateAll(links => links.map(link => decodeURIComponent(new URL((link as HTMLAnchorElement).href).pathname.split('/').at(-1)!)))
}
async function rows(page: Page, selection: Selection = {}, offset = 0, limit = 10) {
  const expected = expectedRows(selection)
  try { await expect.poll(() => ids(page), { message: `seed IDs ${JSON.stringify({ selection, offset, limit })}` }).toEqual(expected.slice(offset, offset + limit).map(row => row.id)) } finally { observations.push({ kind: 'rows', selection, offset, limit, expectedIds: expected.slice(offset, offset + limit).map(row => row.id), observedIds: await ids(page), expectedTotal: expected.length, observedRange: await footer(page).locator('[data-list-range]').textContent() }) }
  await expect(footer(page).locator('[data-list-range]')).toHaveText(en.listRangeTotal.replace('{{start}}', String(expected.length ? offset + 1 : 0)).replace('{{end}}', String(Math.min(offset + limit, expected.length))).replace('{{total}}', String(expected.length)))
}
async function counts(page: Page, selection: Selection = {}) {
  observations.push({ kind: 'counts', selection, expected: expectedCounts(selection), observed: await page.getByRole('group', { name: en.listViews }).textContent() })
  for (const [view, count] of Object.entries(expectedCounts(selection))) await expect(page.getByRole('group', { name: en.listViews }).getByRole('button', { name: new RegExp(`^${labels[view]}`) })).toHaveText(`${labels[view]}${count}`)
  if (selection.actor === 'staff') await expect(page.getByRole('button', { name: /^Pending invitations/ })).toHaveCount(0)
}
async function tab(page: Page, view: string) { await page.getByRole('group', { name: en.listViews }).getByRole('button', { name: new RegExp(`^${labels[view]}`) }).click() }
// DOM visibility does not prove intersection with a clipped table's visible area.
async function insideViewport(locator: Locator) {
  await expect(locator).toBeVisible()
  const geometry = await locator.evaluate(element => {
    const rect = element.getBoundingClientRect()
    const clips = [document.documentElement.getBoundingClientRect(), ...Array.from((function* () { for (let parent = element.parentElement; parent; parent = parent.parentElement) yield parent })()).filter(parent => /auto|scroll|hidden|clip/.test(getComputedStyle(parent).overflowX)).map(parent => parent.getBoundingClientRect())]
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, clipLeft: Math.max(0, ...clips.map(clip => clip.left)), clipRight: Math.min(innerWidth, ...clips.map(clip => clip.right)), height: innerHeight }
  })
  observations.push({ kind: 'viewport-intersection', geometry })
  expect(geometry.left).toBeGreaterThanOrEqual(geometry.clipLeft)
  expect(geometry.right).toBeLessThanOrEqual(geometry.clipRight)
  expect(geometry.top).toBeGreaterThanOrEqual(0)
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.height)
}
async function atScrollStart(page: Page) {
  await expect.poll(() => list(page).locator('[data-slot="table-container"]').evaluate(element => element.scrollLeft)).toBe(0)
}
async function openPanel(page: Page) { await page.getByRole('button', { name: en.sortAndFilter, exact: true }).click(); await expect(panel(page)).toBeVisible() }
async function chooseTeam(page: Page, name: string) { await page.getByRole('combobox', { name: 'Team', exact: true }).click(); await page.getByRole('option', { name, exact: true }).click() }
async function save(page: Page, name: string) {
  await savedTrigger(page).click(); await savedMenu(page).getByRole('button', { name: en.savedViewsSaveNew, exact: true }).click()
  await page.getByRole('textbox', { name: en.savedViewsName, exact: true }).fill(name)
  await page.getByRole('dialog').filter({ has: page.getByRole('textbox', { name: en.savedViewsName, exact: true }) }).getByRole('button', { name: en.savedViewsConfirm, exact: true }).click()
  await expect(savedTrigger(page)).toHaveAccessibleName(en.savedViewsMenu)
  await savedTrigger(page).click()
  await expect(savedMenu(page).getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Escape')
}
test('Q2: display preferences survive reload without changing queries, counts, URL or personal views', async ({ page }) => {
  const requests: unknown[] = []
  page.on('request', request => { if (new URL(request.url()).pathname === '/query') requests.push(request.postDataJSON()) })
  await gotoSDK(page, route); await settled(page)
  await rows(page); await counts(page)
  const url = page.url(), before = structuredClone(requests), summary = await footer(page).textContent(), tabs = await list(page).locator('[data-list-slot="tabs"]').textContent()
  const table = list(page).locator('[data-slot="data-table"]')
  await page.getByRole('button', { name: en.listDisplay, exact: true }).click()
  const display = page.getByRole('dialog', { name: en.listDisplayHeading })
  await expect(display.getByRole('checkbox', { name: 'Name', exact: true })).toHaveCount(0)
  await display.getByRole('checkbox', { name: 'Code', exact: true }).click()
  await display.getByRole('checkbox', { name: en.listDisplayCompact, exact: true }).click()
  await expect(table).toHaveAttribute('data-list-density', 'compact')
  await page.keyboard.press('Escape')
  await expect(table.getByRole('columnheader', { name: /Code/ })).toHaveCount(0)
  await expect(table.getByRole('columnheader', { name: /Name/ })).toHaveCount(1)
  expect(requests).toEqual(before); expect(page.url()).toBe(url)
  expect(await footer(page).textContent()).toBe(summary)
  expect(await list(page).locator('[data-list-slot="tabs"]').textContent()).toBe(tabs)
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('workbase:saved-views:')))).toEqual([])
  await reloadSDK(page); await settled(page); await rows(page); await counts(page)
  await expect(table).toHaveAttribute('data-list-density', 'compact')
  await expect(table.getByRole('columnheader', { name: /Code/ })).toHaveCount(0)
  expect(page.url()).toBe(url)
  expect(await footer(page).textContent()).toBe(summary)
  expect(await list(page).locator('[data-list-slot="tabs"]').textContent()).toBe(tabs)
  await page.getByRole('button', { name: en.listDisplay, exact: true }).click()
  await display.getByRole('button', { name: en.listDisplayReset, exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(table).toHaveAttribute('data-list-density', 'comfortable')
  await expect(table.getByRole('columnheader', { name: /Code/ })).toHaveCount(1)
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('workbase:list-prefs:')))).toEqual([])
})

const scenarios = ['populated-admin', 'populated-restricted-staff', 'expanded-filters', 'view-menu', 'access-menu', 'personal-views', 'empty', 'error', 'loading'] as const
for (const language of ['en', 'cs'] as const) {
  const copy = language === 'cs' ? cs : en
  for (const width of [1440, 900, 390]) test(`R294: ${language} toolbar wraps by available space at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.addInitScript(language => localStorage.setItem('console-language', language), language)
    await gotoSDK(page, route); await settled(page)
    const toolbar = list(page).locator('[data-list-slot="toolbar"]')
    const search = toolbar.getByRole('searchbox', { name: copy.search, exact: true })
    const filters = toolbar.getByRole('button', { name: copy.sortAndFilter, exact: true })
    // Locate the existing trigger by semantics, independent of its text/icon presentation.
    const saved = toolbar.getByRole('region', { name: copy.savedViews, exact: true }).locator('button[aria-haspopup="dialog"]')
    const columns = toolbar.getByRole('button', { name: copy.listDisplay, exact: true })
    const searchBox = (await search.boundingBox())!
    const filterBox = (await filters.boundingBox())!
    const savedBox = (await saved.boundingBox())!
    const columnsBox = (await columns.boundingBox())!
    expect(searchBox.y + searchBox.height, 'search has its own top row').toBeLessThanOrEqual(Math.min(filterBox.y, savedBox.y, columnsBox.y))
    if (width >= 900) {
      expect(filterBox.y, 'Filters and Saved views share the second row').toBe(savedBox.y)
      expect(filterBox.y, 'Filters and Columns share the second row').toBe(columnsBox.y)
      expect(filterBox.x + filterBox.width, 'filter and view actions do not overlap').toBeLessThanOrEqual(savedBox.x)
    }
    expect(await toolbar.evaluate(node => node.scrollWidth <= node.clientWidth), 'toolbar has no horizontal overflow').toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'page has no horizontal overflow').toBe(true)
    const controls = await toolbar.locator('input, select, button').evaluateAll(nodes => nodes.map(node => {
      const { x, y, width, height } = node.getBoundingClientRect()
      return { x, y, width, height }
    }).filter(bounds => bounds.width > 0 && bounds.height > 0))
    const toolbarBox = (await toolbar.boundingBox())!
    for (const [index, control] of controls.entries()) {
      expect(control.x, 'control stays inside toolbar left edge').toBeGreaterThanOrEqual(toolbarBox.x)
      expect(control.x + control.width, 'control stays inside toolbar right edge').toBeLessThanOrEqual(toolbarBox.x + toolbarBox.width)
      for (const other of controls.slice(index + 1)) {
        expect(control.x + control.width <= other.x || other.x + other.width <= control.x || control.y + control.height <= other.y || other.y + other.height <= control.y, 'toolbar controls do not overlap').toBe(true)
      }
    }
    observations.push({ kind: 'toolbar-layout', language, width, searchBox, filterBox, savedBox, columnsBox, controls })
  })
  test(`R4: ${language} toolbar relation filter visibly identifies its configured label`, async ({ page }) => {
    await page.addInitScript(language => localStorage.setItem('console-language', language), language)
    await gotoSDK(page, route); await settled(page)
    const team = page.getByRole('combobox', { name: 'Team', exact: true })
    await expect(team).toBeVisible()
    await expect(team).toHaveValue('')
    await expect(team).toHaveAttribute('placeholder', 'Team')
  })
  for (const width of [767, 768, 769, 800, 1023, 1024]) test(`R1: ${language} shell navigation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.addInitScript(language => localStorage.setItem('console-language', language), language)
    await gotoSDK(page, route); await settled(page)
    const gap = page.locator('[data-slot="sidebar-gap"]')
    if (width >= 1024) {
      await expect(page.locator('[data-slot="sidebar-container"]')).toBeVisible()
      expect(await gap.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(0)
      return
    }
    await expect(gap).toHaveCount(0)
    expect((await page.locator('main').boundingBox())!.width).toBe(width)
    const toolbar = list(page).locator('[data-list-slot="toolbar"]')
    const search = toolbar.getByRole('searchbox', { name: copy.search, exact: true })
    const geometry = await toolbar.evaluate(element => {
      const style = getComputedStyle(element)
      return element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
    })
    expect((await search.boundingBox())!.width).toBe(geometry)
    const trigger = page.getByRole('button', { name: copy.openNavigation, exact: true })
    await trigger.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('navigation')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
    await expect(trigger).toBeFocused()
  })
}
for (const width of [1440, 390]) for (const scenario of scenarios) test(`capture ${width} ${scenario}`, async ({ page, context }) => {
  await page.setViewportSize({ width, height: 900 })
  if (scenario === 'populated-restricted-staff') await context.setExtraHTTPHeaders({ Authorization: 'Bearer list-v2-staff-session' })
  let release: (() => void) | undefined
  if (scenario === 'error' || scenario === 'loading') {
    const hold = new Promise<void>(resolve => { release = resolve })
    await page.route('**/query', async intercepted => {
      const query = intercepted.request().postDataJSON()
      if (query.entity !== 'worker' || !query.includeTotal) return intercepted.continue()
      if (scenario === 'loading') await hold
      await intercepted.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"list_v2_injected_failure"}' })
    })
  }
  try {
    await gotoSDK(page, route)
    if (scenario === 'loading') { await expect(list(page).locator('[aria-busy="true"]')).toBeVisible(); await expect(footer(page).locator('[data-list-range]')).toHaveCount(0); await expect(list(page).locator('[data-list-slot="tabs"] .tabular-nums')).toHaveCount(0) }
    else if (scenario === 'error') { await expect(list(page).getByText(en.requestFailed, { exact: true }).first()).toBeVisible(); await expect(footer(page).locator('[data-list-range]')).toHaveCount(0); await expect(list(page).locator('[data-list-slot="tabs"] .tabular-nums')).toHaveCount(0) }
    else {
      await settled(page)
      if (scenario !== 'populated-restricted-staff') { await expect(page.getByRole('button', { name: new RegExp(en.rowAccessActions) })).toHaveCount(10); await expect(page.getByText(en.rowAccessRefreshing, { exact: true })).toHaveCount(0) }
      if (scenario === 'populated-restricted-staff') { await rows(page, { actor: 'staff' }); await expect(page.getByRole('button', { name: new RegExp(en.rowAccessActions) })).toHaveCount(0) }
      if (scenario === 'expanded-filters') { await openPanel(page); await panel(page).getByRole('checkbox', { name: 'active', exact: true }).check(); await panel(page).getByRole('group', { name: 'Name', exact: true }).getByRole('textbox').fill('Worker 04') }
      if (scenario === 'view-menu') await page.getByRole('button', { name: en.listDisplay, exact: true }).click()
      if (scenario === 'access-menu') await page.getByRole('row').filter({ has: page.getByRole('link', { name: 'Worker 002', exact: true }) }).getByRole('button', { name: new RegExp(en.rowAccessActions) }).click()
      if (scenario === 'personal-views') { await save(page, 'Acceptance personal view'); await savedTrigger(page).click() }
      if (scenario === 'empty') { await tab(page, 'empty'); await rows(page, { view: 'empty' }) }
    }
    const reference = ['empty', 'error', 'loading', 'personal-views', 'view-menu', 'populated-restricted-staff'].includes(scenario) ? 'workbase-workers-reference.html' : scenario === 'expanded-filters' ? 'workers-expanded-filters.jpg' : scenario === 'access-menu' ? 'workers-reference-access-menu.jpg' : width === 390 ? 'workers-reference-mobile.jpg' : 'workers-reference-desktop.jpg'
    await capture(page, scenario, reference, scenario === 'loading' ? 'Hold POST /query worker includeTotal until after capture; release as synthetic HTTP 503 in finally' : scenario === 'error' ? 'Fulfill POST /query worker includeTotal with HTTP 503 list_v2_injected_failure' : undefined)
  } finally { release?.(); await page.unrouteAll({ behavior: 'wait' }) }
})

test('paging: exact total, next, previous, last and page-size reset', async ({ page }) => {
  await gotoSDK(page, route); await settled(page); await rows(page); await counts(page)
  await footer(page).getByRole('button', { name: en.nextPage, exact: true }).click(); await rows(page, {}, 10)
  await footer(page).getByRole('button', { name: en.previousPage, exact: true }).click(); await rows(page)
  await footer(page).getByRole('button', { name: '5', exact: true }).click(); await rows(page, {}, 40)
  await expect(footer(page).getByRole('button', { name: en.nextPage, exact: true })).toBeDisabled()
  await footer(page).getByRole('combobox', { name: en.rowsPerPage, exact: true }).selectOption('20'); await rows(page, {}, 0, 20)
})

test('G1: desktop configured access column fits beside separate Actions without scrolling or coverage', async ({ page }) => {
  await gotoSDK(page, route); await settled(page); await rows(page); await atScrollStart(page)
  const headers = list(page).getByRole('columnheader')
  await expect(headers).toHaveCount(6)
  for (const header of await headers.all()) await insideViewport(header)
  const accessHeader = list(page).getByRole('columnheader', { name: en.rowAccess, exact: true })
  const actionsHeader = list(page).getByRole('columnheader', { name: en.actions, exact: true })
  const access = await accessHeader.boundingBox(); const actions = await actionsHeader.boundingBox()
  expect(access!.x + access!.width).toBeLessThanOrEqual(actions!.x + 1)
  const buttons = page.getByRole('button', { name: new RegExp(en.rowAccessActions) })
  await expect(buttons).toHaveCount(10)
  for (const button of await buttons.all()) {
    await insideViewport(button)
    expect(await button.evaluate(element => {
      const rect = element.getBoundingClientRect()
      return [rect.left + 1, rect.right - 1].every(x => element.contains(document.elementFromPoint(x, rect.top + rect.height / 2)))
    })).toBe(true)
  }
  await atScrollStart(page)
})

for (const state of ['empty', 'error'] as const) test(`G2: mobile ${state} message stays in the viewport at scrollLeft zero`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 })
  if (state === 'error') await page.route('**/query', intercepted => {
    const query = intercepted.request().postDataJSON()
    return query.entity === 'worker' && query.includeTotal ? intercepted.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"list_v2_injected_failure"}' }) : intercepted.continue()
  })
  await gotoSDK(page, route)
  if (state === 'empty') { await settled(page); await tab(page, 'empty'); await rows(page, { view: 'empty' }) }
  const message = list(page).getByText(state === 'empty' ? en.noResults : en.requestFailed, { exact: true }).first()
  await expect(message).toBeVisible(); await atScrollStart(page); await insideViewport(message); await atScrollStart(page)
  if (state === 'error') {
    await insideViewport(list(page).getByRole('alert'))
    await insideViewport(list(page).getByText(en.listRequestFailedDescription, { exact: true }))
    await insideViewport(list(page).getByRole('button', { name: en.listRetry, exact: true }))
    await atScrollStart(page)
  }
})

test('G3: in-panel retry repeats the failed query and preserves committed settings and page', async ({ page }) => {
  await gotoSDK(page, route); await settled(page)
  await page.getByRole('searchbox', { name: en.search, exact: true }).fill('Worker')
  await expect.poll(() => new URL(page.url()).searchParams.get('search')).toBe('Worker')
  await rows(page, { search: 'Worker' }); await tab(page, 'inactive'); await rows(page, { view: 'inactive', search: 'Worker' })
  await expect(footer(page).getByRole('button', { name: '2', exact: true })).toBeEnabled()
  let failing = true
  const queries: unknown[] = []
  await page.route('**/query', intercepted => {
    const query = intercepted.request().postDataJSON()
    if (query.entity !== 'worker' || !query.includeTotal) return intercepted.continue()
    queries.push(query)
    return failing ? intercepted.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"list_v2_injected_failure"}' }) : intercepted.continue()
  })
  await footer(page).getByRole('button', { name: '2', exact: true }).click()
  const alert = list(page).getByRole('alert')
  await expect.soft(alert.getByText(en.requestFailed, { exact: true })).toHaveCount(1)
  await expect.soft(alert).toContainText('Your list settings are preserved.')
  const retry = alert.getByRole('button', { name: 'Try again', exact: true })
  await expect(retry).toBeVisible(); await insideViewport(retry)
  const failedUrl = page.url(); expect(new URL(failedUrl).searchParams.get('page')).toBe('2')
  expect(queries).toHaveLength(1)
  failing = false; await retry.click()
  await rows(page, { view: 'inactive', search: 'Worker' }, 10); await counts(page, { view: 'inactive', search: 'Worker' })
  expect(queries).toHaveLength(2); expect(queries[1]).toEqual(queries[0]); expect(page.url()).toBe(failedUrl)
  await expect(page.getByRole('searchbox', { name: en.search, exact: true })).toHaveValue('Worker')
  await expect(page.getByRole('group', { name: en.listViews }).getByRole('button', { name: /^Inactive workers/ })).toHaveAttribute('aria-pressed', 'true')
  await expect(alert).toHaveCount(0)
})

test('tab counts replace only the view under search, relation filter and restricted grants', async ({ page, context }) => {
  await gotoSDK(page, route); await settled(page)
  for (const view of Object.keys(labels)) { await tab(page, view); await rows(page, { view }); await counts(page) }
  await tab(page, 'all'); await page.getByRole('searchbox', { name: en.search, exact: true }).fill('Worker 04')
  await rows(page, { search: 'Worker 04' }); await counts(page, { search: 'Worker 04' })
  await chooseTeam(page, 'North team'); await rows(page, { search: 'Worker 04', team: 'north' }); await counts(page, { search: 'Worker 04', team: 'north' })
  await page.getByRole('searchbox', { name: en.search, exact: true }).fill('no-such-seeded-worker'); await rows(page, { search: 'no-such-seeded-worker', team: 'north' }); await counts(page, { search: 'no-such-seeded-worker', team: 'north' })
  await context.setExtraHTTPHeaders({ Authorization: 'Bearer list-v2-staff-session' }); await gotoSDK(page, route); await settled(page)
  await rows(page, { actor: 'staff' }); await counts(page, { actor: 'staff' })
  await page.getByRole('searchbox', { name: en.search, exact: true }).fill('Worker 04'); await rows(page, { actor: 'staff', search: 'Worker 04' }); await counts(page, { actor: 'staff', search: 'Worker 04' })
  await chooseTeam(page, 'South team'); await rows(page, { actor: 'staff', search: 'Worker 04', team: 'south' }); await counts(page, { actor: 'staff', search: 'Worker 04', team: 'south' })
})

test('panel: staged rows/counts/URL, Cancel discard, Apply once and reset page', async ({ page }) => {
  const requests: unknown[] = []
  page.on('request', request => { if (new URL(request.url()).pathname === '/query') { const q = request.postDataJSON(); if (q.entity === 'worker' && q.includeTotal) requests.push(q) } })
  await gotoSDK(page, route); await settled(page); await footer(page).getByRole('button', { name: '3', exact: true }).click(); await rows(page, {}, 20)
  const url = page.url(); const before = requests.length
  await openPanel(page); await panel(page).getByRole('group', { name: 'Name', exact: true }).getByRole('textbox').fill('Worker 04'); await panel(page).getByRole('checkbox', { name: 'active', exact: true }).check()
  await rows(page, {}, 20); await counts(page); expect(page.url()).toBe(url); expect(requests).toHaveLength(before)
  await panel(page).getByRole('button', { name: en.cancel, exact: true }).click()
  await openPanel(page); await expect(panel(page).getByRole('group', { name: 'Name', exact: true }).getByRole('textbox')).toHaveValue(''); await expect(panel(page).getByRole('checkbox', { name: 'active', exact: true })).not.toBeChecked()
  await panel(page).getByRole('group', { name: 'Name', exact: true }).getByRole('textbox').fill('Worker 04'); await panel(page).getByRole('checkbox', { name: 'active', exact: true }).check(); await panel(page).getByRole('button', { name: en.applyFilter, exact: true }).click()
  await rows(page, { name: 'Worker 04', status: 'active' }); await counts(page, { name: 'Worker 04', status: 'active' }); expect(requests).toHaveLength(before + 1)
  await openPanel(page); await expect(panel(page).getByRole('group', { name: 'Name', exact: true }).getByRole('textbox')).toHaveValue('Worker 04')
  // Closing through the shared toolbar discards this mounted draft too.
  await panel(page).getByRole('group', { name: 'Name', exact: true }).getByRole('textbox').fill('discard-me'); await page.getByRole('button', { name: en.sortAndFilter, exact: true }).click()
  await openPanel(page); await expect(panel(page).getByRole('group', { name: 'Name', exact: true }).getByRole('textbox')).toHaveValue('Worker 04')
})

test('URL: reload restores committed settings and current page', async ({ page }) => {
  await gotoSDK(page, route); await settled(page); await tab(page, 'inactive'); await rows(page, { view: 'inactive' })
  await footer(page).getByRole('button', { name: '2', exact: true }).click(); await rows(page, { view: 'inactive' }, 10)
  await reloadSDK(page); await settled(page); await rows(page, { view: 'inactive' }, 10)
})

test('URL: copied URL restores the current page as well as settings', async ({ page, context }) => {
  await gotoSDK(page, route); await settled(page); await tab(page, 'inactive'); await rows(page, { view: 'inactive' })
  await footer(page).getByRole('button', { name: '2', exact: true }).click(); await rows(page, { view: 'inactive' }, 10)
  const other = await context.newPage()
  try { await gotoSDK(other, page.url()); await settled(other); await rows(other, { view: 'inactive' }, 10) } finally { await other.close() }
})

test('URL: back and forward restore settings and history paging', async ({ page }) => {
  await gotoSDK(page, route); await settled(page); await tab(page, 'inactive'); await rows(page, { view: 'inactive' })
  await footer(page).getByRole('button', { name: '2', exact: true }).click(); await rows(page, { view: 'inactive' }, 10)
  await tab(page, 'active'); await rows(page, { view: 'active' }); await page.goBack(); await rows(page, { view: 'inactive' }, 10)
  await page.goForward(); await rows(page, { view: 'active' })
})

test('URL: invalid and forbidden parameters and relation IDs are sanitized', async ({ page, context }) => {
  await context.setExtraHTTPHeaders({ Authorization: 'Bearer list-v2-staff-session' })
  const filters = JSON.stringify([{ field: 'user', predicate: { eq: 'admin' } }, { field: 'team_id', predicate: { in: ['north'] } }])
  await gotoSDK(page, `${route}?view=invited&rowAccess=invited&sort=forbidden&page=-7&pageSize=13&filters=${encodeURIComponent(filters)}`)
  await settled(page); await rows(page, { actor: 'staff' }); await counts(page, { actor: 'staff' })
  await expect.poll(() => page.url()).not.toMatch(/north|invited|forbidden|pageSize=13/)
  await expect(page.getByText('North team', { exact: true })).toHaveCount(0)
})

test('personal views: save, apply, rename, delete and reload; settings only', async ({ page }) => {
  await gotoSDK(page, route); await settled(page); await tab(page, 'inactive'); await rows(page, { view: 'inactive' }); await save(page, 'My inactive')
  await reloadSDK(page); await settled(page); await savedTrigger(page).click()
  await expect(savedMenu(page).getByRole('button', { name: 'My inactive', exact: true })).toBeVisible()
  await expect(savedMenu(page).locator('button[aria-current="true"]')).toHaveCount(0)
  await expect(savedMenu(page).getByRole('button', { name: en.savedViewsRenameThis, exact: true })).toHaveCount(0)
  await expect(savedMenu(page).getByRole('button', { name: en.savedViewsDeleteThis, exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await tab(page, 'active'); await rows(page, { view: 'active' }); await savedTrigger(page).click()
  await savedMenu(page).getByRole('button', { name: 'My inactive', exact: true }).click(); await rows(page, { view: 'active' })
  await savedMenu(page).getByRole('button', { name: en.savedViewsApplyView, exact: true }).click(); await rows(page, { view: 'inactive' })
  await savedTrigger(page).click(); await savedMenu(page).getByRole('button', { name: en.savedViewsRenameThis, exact: true }).click()
  await page.getByRole('textbox', { name: en.savedViewsName, exact: true }).fill('Renamed inactive'); await page.getByRole('dialog').filter({ has: page.getByRole('textbox', { name: en.savedViewsName, exact: true }) }).getByRole('button', { name: en.savedViewsConfirm, exact: true }).click()
  const stored = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('workbase:saved-views:')).map(key => JSON.parse(localStorage.getItem(key)!)))
  record('observations', 'personal-views-storage', stored)
  expect(stored).toHaveLength(1)
  for (const entry of stored[0].entries) expect(Object.keys(entry.search).sort()).toEqual(['direction', 'sort', 'view'])
  await reloadSDK(page); await settled(page); await savedTrigger(page).click(); await savedMenu(page).getByRole('button', { name: 'Renamed inactive', exact: true }).click(); await savedMenu(page).getByRole('button', { name: en.savedViewsApplyView, exact: true }).click(); await rows(page, { view: 'inactive' })
  await savedTrigger(page).click(); await savedMenu(page).getByRole('button', { name: en.savedViewsDeleteThis, exact: true }).click(); await page.getByRole('button', { name: en.savedViewsDelete, exact: true }).click()
  await reloadSDK(page); await settled(page); await savedTrigger(page).click(); await expect(savedMenu(page).getByRole('button', { name: 'Renamed inactive', exact: true })).toHaveCount(0)
})

test('personal views: update current view through the naming dialog and reload', async ({ page }) => {
  await gotoSDK(page, route); await settled(page); await tab(page, 'inactive'); await rows(page, { view: 'inactive' }); await save(page, 'Update me')
  await tab(page, 'active'); await rows(page, { view: 'active' })
  await page.getByRole('button', { name: en.savedViewsSaveChanges, exact: true }).click()
  const naming = page.getByRole('dialog').filter({ has: page.getByRole('textbox', { name: en.savedViewsName, exact: true }) })
  await naming.getByRole('button', { name: en.savedViewsConfirm, exact: true }).click({ timeout: 5000 })
  await reloadSDK(page); await settled(page); await tab(page, 'inactive'); await rows(page, { view: 'inactive' })
  await savedTrigger(page).click(); await savedMenu(page).getByRole('button', { name: 'Update me', exact: true }).click(); await savedMenu(page).getByRole('button', { name: en.savedViewsApplyView, exact: true }).click(); await rows(page, { view: 'active' })
})

test('personal views: rename then update in the same mounted session', async ({ page }) => {
  await gotoSDK(page, route); await settled(page); await tab(page, 'inactive'); await rows(page, { view: 'inactive' }); await save(page, 'Compound inactive')
  await reloadSDK(page); await settled(page); await tab(page, 'active'); await rows(page, { view: 'active' })
  await savedTrigger(page).click(); await savedMenu(page).getByRole('button', { name: 'Compound inactive', exact: true }).click(); await savedMenu(page).getByRole('button', { name: en.savedViewsApplyView, exact: true }).click(); await rows(page, { view: 'inactive' })
  await savedTrigger(page).click(); await savedMenu(page).getByRole('button', { name: en.savedViewsRenameThis, exact: true }).click()
  await page.getByRole('textbox', { name: en.savedViewsName, exact: true }).fill('Compound renamed')
  const naming = () => page.getByRole('dialog').filter({ has: page.getByRole('textbox', { name: en.savedViewsName, exact: true }) })
  await naming().getByRole('button', { name: en.savedViewsConfirm, exact: true }).click()
  await tab(page, 'active'); await rows(page, { view: 'active' }); await page.getByRole('button', { name: en.savedViewsSaveChanges, exact: true }).click()
  // Preserve the original pointer-interaction oracle; never force past an overlay.
  await naming().getByRole('button', { name: en.savedViewsConfirm, exact: true }).click({ timeout: 5000 })
  await reloadSDK(page); await settled(page); await tab(page, 'inactive'); await rows(page, { view: 'inactive' }); await savedTrigger(page).click(); await savedMenu(page).getByRole('button', { name: 'Compound renamed', exact: true }).click(); await savedMenu(page).getByRole('button', { name: en.savedViewsApplyView, exact: true }).click(); await rows(page, { view: 'active' })
})

test('same mounted tab: admin → staff → admin must replace rows, totals, counts and personal namespace', async ({ page, context }) => {
  test.setTimeout(120_000)
  await gotoSDK(page, route); await settled(page); await rows(page); await save(page, 'Admin private view')
  await footer(page).getByRole('button', { name: '3', exact: true }).click(); await rows(page, {}, 20)
  await openPanel(page); await panel(page).getByRole('group', { name: 'Name', exact: true }).getByRole('textbox').fill('admin-only-draft')
  // Real session replacement; observe the shipped authority poll in the same mounted document.
  for (const actor of ['staff', 'admin'] as const) {
    await test.step(`session becomes ${actor}`, async () => {
      await context.setExtraHTTPHeaders({ Authorization: `Bearer list-v2-${actor}-session` })
      await expect.configure({ soft: true }).poll(() => ids(page), { timeout: 38_000, message: `real session transition to ${actor}: seeded first page` }).toEqual(expectedRows({ actor }).slice(0, 10).map(row => row.id))
      const expected = expectedRows({ actor }); const actualIds = await ids(page)
      observations.push({ kind: 'actor', actor, expectedIds: expected.slice(0, 10).map(row => row.id), observedIds: actualIds, expectedTotal: expected.length, observedRange: await footer(page).locator('[data-list-range]').textContent(), expectedCounts: expectedCounts({ actor }), observedTabs: await page.getByRole('group', { name: en.listViews }).textContent() })
      await expect.soft(footer(page).locator('[data-list-range]')).toHaveText(en.listRangeTotal.replace('{{start}}', '1').replace('{{end}}', '10').replace('{{total}}', String(expected.length)))
      for (const [view, count] of Object.entries(expectedCounts({ actor }))) await expect.soft(page.getByRole('group', { name: en.listViews }).getByRole('button', { name: new RegExp(`^${labels[view]}`) })).toHaveText(`${labels[view]}${count}`)
      await expect.soft(panel(page)).toHaveCount(0)
      if (actor === 'staff') { await expect.soft(page.getByRole('button', { name: /^Pending invitations/ })).toHaveCount(0); await expect.soft(page.getByRole('button', { name: new RegExp(en.rowAccessActions) })).toHaveCount(0) }
      await savedTrigger(page).click()
      await expect.soft(savedMenu(page).getByRole('button', { name: 'Admin private view', exact: true })).toHaveCount(actor === 'admin' ? 1 : 0)
      await page.keyboard.press('Escape')
    })
  }
})

test('access: allowed admin actions; denied staff controls and real API authorization', async ({ page, context, request }) => {
  await gotoSDK(page, route); await settled(page)
  for (const [id, state] of [['w001', 'no_account'], ['w002', 'invited'], ['w003', 'signed_in'], ['w005', 'expired']] as const) {
    const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: workers.find(worker => worker.id === id)!.name, exact: true }) })
    const trigger = row.getByRole('button', { name: new RegExp(en.rowAccessActions) })
    await expect(trigger).toHaveAccessibleName(new RegExp(en[`rowAccess_${state}`])); await trigger.click(); await expect(page.getByRole('menu')).toContainText(en[`rowAccess_${state}`]); await page.keyboard.press('Escape')
  }
  const allowed = await request.get('/orgs/org-a/row-access/worker/w001', { headers: { 'X-Organization-Id': 'org-a' } }); expect(allowed.status()).toBe(200)
  const noAccessRow = page.getByRole('row').filter({ has: page.getByRole('link', { name: 'Worker 001', exact: true }) }); await noAccessRow.getByRole('button', { name: new RegExp(en.rowAccessActions) }).click(); await page.getByRole('menuitem', { name: en.rowFindMember, exact: true }).click(); await expect(page.getByRole('dialog')).toBeVisible(); await page.getByRole('dialog').getByRole('button', { name: en.cancel, exact: true }).click()
  const headers = { Authorization: 'Bearer list-v2-staff-session', 'X-Organization-Id': 'org-a' }
  const denied = await request.get('/orgs/org-a/row-access/worker/w004', { headers }); expect(denied.status()).toBe(403)
  const mutation = await request.post('/orgs/org-a/invitations', { headers, data: { email: 'denied@example.test', target: { entity: 'worker', row: 'w004' } } }); expect(mutation.status()).toBe(403)
  await context.setExtraHTTPHeaders({ Authorization: 'Bearer list-v2-staff-session' }); await gotoSDK(page, route); await settled(page); await rows(page, { actor: 'staff' })
  await expect(page.getByRole('columnheader', { name: en.rowAccess, exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: new RegExp(en.rowAccessActions) })).toHaveCount(0)
})

for (const width of [360, 390]) for (const language of ['en', 'cs'] as const) test(`paging: 200% text middle page ${width} ${language}`, async ({ page, context }) => {
  const copy = language === 'cs' ? cs : en
  await page.setViewportSize({ width, height: 1000 })
  await context.addInitScript(language => localStorage.setItem('console-language', language), language)
  await gotoSDK(page, `${route}?page=3`)
  await expect(list(page).locator('[data-list-range]')).toBeVisible()
  await page.evaluate(async () => {
    document.documentElement.style.fontSize = '32px'
    await document.fonts.ready
    await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))
  })
  const paging = list(page).locator('[data-list-paging]')
  const previous = paging.getByRole('button', { name: copy.previousPage, exact: true })
  const current = paging.getByRole('button', { name: '3', exact: true })
  const next = paging.getByRole('button', { name: copy.nextPage, exact: true })
  await expect(current).toHaveAttribute('aria-current', 'page')
  await expect(previous).toBeEnabled()
  await expect(next).toBeEnabled()
  await paging.scrollIntoViewIfNeeded()
  // Based on the review's paging-focus/probe geometry: DOM visibility alone
  // misses controls clipped by the paging group's own horizontal viewport.
  const checkPaging = async (phase: string) => {
    const viewport = await paging.evaluate(element => {
      const box = element.getBoundingClientRect()
      return { left: box.left + element.clientLeft, right: box.left + element.clientLeft + element.clientWidth, top: box.top, bottom: box.bottom, scrollLeft: element.scrollLeft, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }
    })
    for (const control of [previous, current, next]) {
      await expect(control).toBeVisible()
      const box = (await control.boundingBox())!
      observations.push({ kind: 'paging-clip', phase, viewport, name: await control.getAttribute('aria-label') ?? await control.textContent(), box })
      expect.soft(box.x).toBeGreaterThanOrEqual(viewport.left)
      expect.soft(box.x + box.width).toBeLessThanOrEqual(viewport.right)
      expect.soft(box.y).toBeGreaterThanOrEqual(viewport.top)
      expect.soft(box.y + box.height).toBeLessThanOrEqual(viewport.bottom)
    }
    expect.soft(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth)
    expect.soft(viewport.scrollLeft).toBe(0)
  }
  await checkPaging('before focus')
  await next.focus()
  await expect(next).toBeFocused()
  await checkPaging('after focusing Next')
  await page.screenshot({ path: `${process.env.LIST_V2_OUTPUT}/paging-200-${width}-${language}.png` })
  // Collapsed page numbers must also leave the keyboard order.
  await previous.focus()
  await page.keyboard.press('Tab'); await expect(current).toBeFocused()
  await page.keyboard.press('Tab'); await expect(next).toBeFocused()
  await page.keyboard.press('Enter')
  await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBe('4')
})

// The review's app-boundary probe uses synthetic rows/total to exercise the
// supported offset bound without changing the backend pagination fixtures.
for (const width of [1110, 1231, 1233]) for (const language of ['en', 'cs'] as const) for (const number of [900, 1000]) test(`paging: 200% text boundary ${width} ${language} page ${number}`, async ({ page, context }, testInfo) => {
  const copy = language === 'cs' ? cs : en
  await page.setViewportSize({ width, height: 1000 })
  await context.addInitScript(language => localStorage.setItem('console-language', language), language)
  await page.route('**/query', async intercepted => {
    const query = intercepted.request().postDataJSON()
    if (query.entity !== 'worker' || !query.includeTotal) return intercepted.continue()
    const response = await intercepted.fetch({ postData: JSON.stringify({ ...query, offset: 0 }) })
    await intercepted.fulfill({ response, json: { ...await response.json(), total: 10010 } })
  })
  await gotoSDK(page, `${route}?page=${number}`)
  await expect(list(page).locator('[data-list-range]')).toBeVisible()
  await page.evaluate(async () => {
    document.documentElement.style.fontSize = '32px'
    await document.fonts.ready
    await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))
  })
  const paging = list(page).locator('[data-list-paging]')
  const previous = paging.getByRole('button', { name: copy.previousPage, exact: true })
  const current = paging.getByRole('button', { name: String(number), exact: true })
  const next = paging.getByRole('button', { name: copy.nextPage, exact: true })
  await expect(current).toHaveAttribute('aria-current', 'page')
  await expect(previous).toBeEnabled()
  await expect(next).toBeEnabled()
  await paging.scrollIntoViewIfNeeded()
  // Check every clipping ancestor as well as the paging viewport; visible DOM
  // alone missed the section's overflow:hidden in the review reproduction.
  const checkPaging = async (phase: string, controls = [previous, current, next], focusRing = false) => {
    // Observe the completed native focus-ring transition before measuring.
    if (focusRing) await layoutDiagnostics(controls[0], true)
    for (const control of controls) {
      const geometry = await control.evaluate((element, focusRing) => {
        const box = element.getBoundingClientRect()
        const clips = [{ left: 0, right: innerWidth }]
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          if (/auto|scroll|hidden|clip/.test(getComputedStyle(parent).overflowX)) {
            const rect = parent.getBoundingClientRect()
            const style = getComputedStyle(parent)
            clips.push({ left: rect.left + parseFloat(style.borderLeftWidth), right: rect.right - parseFloat(style.borderRightWidth) })
          }
        }
        const style = getComputedStyle(element)
        const outlineWidth = style.outlineStyle === 'none' ? 0 : parseFloat(style.outlineWidth)
        const outlineOffset = parseFloat(style.outlineOffset)
        // The shipped Button uses a box-shadow ring; include it as well as any
        // CSS outline so this oracle measures the visible focus indicator.
        const ringWidth = Math.max(0, ...style.boxShadow.split(/,(?![^()]*\))/).filter(shadow => !shadow.includes('inset')).map(shadow => {
          const lengths = Array.from(shadow.matchAll(/(-?[\d.]+)px/g), match => Number(match[1]))
          return lengths.length >= 4 ? lengths[3] : 0
        }))
        const focusExtent = focusRing ? Math.max(0, outlineWidth + outlineOffset, ringWidth) : 0
        return { left: box.left, right: box.right, focusLeft: box.left - focusExtent, focusRight: box.right + focusExtent, outlineWidth, outlineOffset, ringWidth, focusExtent, focused: element === document.activeElement, focusVisible: element.matches(':focus-visible'), clipLeft: Math.max(...clips.map(clip => clip.left)), clipRight: Math.min(...clips.map(clip => clip.right)) }
      }, focusRing)
      observations.push({ kind: 'paging-boundary', phase, number, width, language, geometry })
      if (width === 1110 && number === 1000) {
        const diagnostic = await layoutDiagnostics(control)
        await attachLayoutDiagnostics(page, testInfo, `case-A-${language}-${phase}-${diagnostic.controls[0].name}`, { scenarioWidth: width, phase, number, language, geometry, ...diagnostic })
      }
      await expect(control).toBeVisible()
      expect.soft(geometry.left).toBeGreaterThanOrEqual(geometry.clipLeft)
      expect.soft(geometry.right).toBeLessThanOrEqual(geometry.clipRight)
      if (focusRing) {
        expect(geometry.focused).toBe(true)
        expect(geometry.focusVisible).toBe(true)
        expect(geometry.focusExtent).toBeGreaterThan(0)
        expect.soft(geometry.focusLeft).toBeGreaterThanOrEqual(geometry.clipLeft)
        expect.soft(geometry.focusRight).toBeLessThanOrEqual(geometry.clipRight)
      }
    }
  }
  await checkPaging('before focus')
  if (width === 1110 && number === 1000) await captureSDK(page, 'pagination-before-focus', language, testInfo)
  await next.focus()
  await expect(next).toBeFocused()
  await checkPaging('after focusing Next')
  if (width === 1110 && number === 1000) {
    await captureSDK(page, 'pagination-focused-Next', language, testInfo)
    await previous.focus()
    await checkPaging('after focusing Previous')
    await captureSDK(page, 'pagination-focused-Previous', language, testInfo)
  }
  if (width === 1110 && number === 1000) {
    // Below the supported layout widths, retain native focus/scroll recovery
    // even when Previous/current/Next themselves cannot fit on one line.
    await page.setViewportSize({ width: 320, height: 1000 })
    await paging.scrollIntoViewIfNeeded()
    await previous.focus()
    await checkPaging('overflow fallback after focusing Previous', [previous], true)
    await captureSDK(page, 'pagination-focused-Previous', language, testInfo)
    const overflow = await paging.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }))
    expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth)
    await page.keyboard.press('Tab')
    await expect(current).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(next).toBeFocused()
    expect.soft(await paging.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
    await checkPaging('overflow fallback after focusing Next', [next], true)
    await captureSDK(page, 'pagination-focused-Next', language, testInfo)
    await page.setViewportSize({ width, height: 1000 })
  }
  // Exercise the visible buttons in DOM order, excluding collapsed numbers.
  const visible = paging.getByRole('button')
  await expect(visible).toHaveCount(width < 1232 ? 3 : number === 900 ? 9 : 7)
  await previous.focus()
  for (let index = 1; index < await visible.count(); index++) {
    await page.keyboard.press('Tab')
    await expect(visible.nth(index)).toBeFocused()
  }
  await expect(next).toBeFocused()
  await page.keyboard.press('Enter')
  await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBe(String(number + 1))
  await page.unrouteAll({ behavior: 'wait' })
})

for (const density of ['comfortable', 'compact'] as const) test(`#291: applied table typography in ${density} density`, async ({ page }) => {
  await gotoSDK(page, route); await settled(page); await rows(page)
  const table = list(page).locator('[data-slot="data-table"]')
  const accessButtons = table.getByRole('button', { name: new RegExp(en.rowAccessActions) })
  await expect(accessButtons).toHaveCount(10)
  if (density === 'compact') {
    await page.getByRole('button', { name: en.listDisplay, exact: true }).click()
    await page.getByRole('dialog', { name: en.listDisplayHeading }).getByRole('checkbox', { name: en.listDisplayCompact }).click()
    await page.keyboard.press('Escape')
  }
  await expect(table).toHaveAttribute('data-list-density', density)
  const groups = [
    { name: 'ordinary cells', locator: table.locator('tbody [data-row-id] > td:nth-child(-n+4)'), count: 40 },
    { name: 'application access content', locator: table.locator('tbody [data-row-id] > td:nth-child(5)'), count: 10 },
    { name: 'application access buttons', locator: accessButtons, count: 10 },
    { name: 'sortable header buttons', locator: table.locator('thead th button'), count: 3 },
    { name: 'plain headers', locator: table.locator('thead th:not(:has(button))'), count: 3 },
  ]
  // Measure both the cell/control and the actual text parents: nested spans or
  // links can override inheritance even when the shared token selector matches.
  for (const group of groups) {
    await expect(group.locator, `${density}: ${group.name}`).toHaveCount(group.count)
    const measurements = await group.locator.evaluateAll(elements => elements.map(element => {
      const measure = (node: Element) => {
        const style = getComputedStyle(node)
        return { tag: node.tagName, text: node.textContent?.trim(), fontSize: style.fontSize, lineHeight: style.lineHeight }
      }
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      const text = []
      let node
      while ((node = walker.nextNode())) {
        const parent = node.parentElement!
        if (node.textContent?.trim() && !parent.closest('svg, .sr-only, [aria-hidden="true"]')) text.push(measure(parent))
      }
      return { root: measure(element), text }
    }))
    observations.push({ kind: 'applied-table-typography', density, group: group.name, measurements })
    for (const [index, measurement] of measurements.entries()) {
      const label = `${density}: ${group.name} ${index}: ${measurement.root.text}`
      // Icon-only access controls still need the same applied button metrics.
      if (group.name !== 'application access buttons') expect(measurement.text.length, label).toBeGreaterThan(0)
      for (const node of [measurement.root, ...measurement.text]) {
        expect.soft({ fontSize: node.fontSize, lineHeight: node.lineHeight }, `${label} (${node.tag})`).toEqual({ fontSize: '14px', lineHeight: '20px' })
      }
    }
  }
})

for (const width of [1440, 390, 360]) for (const actor of ['admin', 'staff'] as const) for (const language of ['en', 'cs'] as const) test(`G4–G6 polish ${width} ${actor} ${language}`, async ({ page, context }, testInfo) => {
  const copy = language === 'cs' ? cs : en
  await page.setViewportSize({ width, height: 1000 })
  await context.setExtraHTTPHeaders({ Authorization: `Bearer list-v2-${actor}-session` })
  await context.addInitScript(language => localStorage.setItem('console-language', language), language)
  await gotoSDK(page, route)
  await expect(list(page).locator('[data-list-range]')).toBeVisible()
  const table = list(page).locator('[data-slot="data-table"]')
  const row = table.locator('tbody [data-row-id]').first()
  await expect(table).toHaveAttribute('data-list-density', 'comfortable')
  expect(await row.locator('td').first().evaluate(element => [getComputedStyle(element).fontSize, getComputedStyle(element).lineHeight])).toEqual(['14px', '20px'])
  expect(Math.round((await row.boundingBox())!.height)).toBe(actor === 'admin' ? 53 : 61)
  if (width === 1440) {
    expect(await page.locator('h1').evaluate(element => [getComputedStyle(element).fontSize, getComputedStyle(element).fontWeight])).toEqual(['29px', '400'])
    await expect.poll(async () => Math.round((await page.locator('[data-slot="sidebar-gap"]').boundingBox())!.width)).toBe(206)
  }
  await page.getByRole('button', { name: copy.listDisplay, exact: true }).click()
  const display = page.getByRole('dialog', { name: copy.listDisplayHeading })
  await display.getByRole('checkbox', { name: copy.listDisplayCompact }).click()
  await expect(table).toHaveAttribute('data-list-density', 'compact')
  expect(Math.round((await row.boundingBox())!.height)).toBe(actor === 'admin' ? 53 : 45)
  expect(new URL(page.url()).searchParams.has('compact')).toBe(false)
  await page.keyboard.press('Escape')
  const scroller = list(page).getByRole('region', { name: copy.listScrollRegion })
  await expect(scroller).toHaveAttribute('tabindex', '0')
  const cue = list(page).locator('[data-list-overflow]')
  if (width < 500) {
    await expect(cue).toHaveAttribute('data-list-overflow', 'end')
    await scroller.focus(); await page.keyboard.press('End')
    await expect(cue).toHaveAttribute('data-list-overflow', 'start')
    await page.keyboard.press('Home')
    await expect(cue).toHaveAttribute('data-list-overflow', 'end')
    await page.getByRole('button', { name: copy.listDisplay, exact: true }).click()
    for (const checkbox of await display.getByRole('checkbox').all()) {
      if (await checkbox.getAttribute('aria-checked') === 'true' && await checkbox.getAttribute('aria-label') !== copy.listDisplayCompact && await checkbox.textContent() !== copy.listDisplayCompact) {
        // Compact is restored separately; configured data columns can all be hidden.
        const label = await checkbox.evaluate(element => element.closest('label')?.textContent)
        if (label !== copy.listDisplayCompact) await checkbox.click()
      }
    }
    await page.keyboard.press('Escape')
    await expect(cue).toHaveCount(0)
  } else {
    await expect(cue).toHaveCount(0)
    await page.setViewportSize({ width: 360, height: 1000 })
    await expect(cue).toHaveAttribute('data-list-overflow', 'end')
    await page.setViewportSize({ width, height: 1000 })
    await expect(cue).toHaveCount(0)
  }
  // Text enlargement may move whole groups, never split Previous/current/Next.
  await page.evaluate(() => { document.documentElement.style.fontSize = '20px' })
  const lookup = page.getByRole('combobox', { name: 'Team', exact: true })
  await insideViewport(lookup)
  expect((await lookup.boundingBox())!.width).toBeGreaterThanOrEqual(130)
  await expect(lookup).toHaveAttribute('placeholder', 'Team')
  const paging = list(page).locator('[data-list-paging]')
  const previous = paging.getByRole('button', { name: copy.previousPage, exact: true })
  const current = paging.locator('[aria-current="page"]')
  const next = paging.getByRole('button', { name: copy.nextPage, exact: true })
  const diagnostic = await layoutDiagnostics(previous.or(current).or(next), true)
  await attachLayoutDiagnostics(page, testInfo, `pagination-atomic-${width}-${actor}-${language}`, { width, actor, language, ...diagnostic })
  const controls = diagnostic.controls
  expect(controls).toHaveLength(3)
  // The group may move to another row as a unit. Its three controls must still
  // share a row; no individual-control wrap exception or wider tolerance.
  expect(Math.abs(controls[0].box.top - controls[2].box.top)).toBeLessThan(2)
  // The numbered button is shorter than Previous/Next; compare its centerline.
  const centers = controls.map(control => control.box.top + control.box.height / 2)
  expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(2)
  for (const { box, clip, hitAtCenter, disabled } of controls) {
    expect(box.left).toBeGreaterThanOrEqual(clip.left)
    expect(box.right).toBeLessThanOrEqual(clip.right)
    expect(box.top).toBeGreaterThanOrEqual(clip.top)
    expect(box.bottom).toBeLessThanOrEqual(clip.bottom)
    if (!disabled) expect(hitAtCenter).toBe(true)
  }
  for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
    const a = controls[i].box; const b = controls[j].box
    expect(a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom).toBe(false)
  }
  const onPage = async (number: number) => {
    await expect(current).toHaveText(String(number))
    await expect.poll(() => ids(page)).toEqual(expectedRows({ actor }).slice((number - 1) * 10, number * 10).map(row => row.id))
  }
  await next.click(); await onPage(2)
  await previous.click(); await onPage(1)
  const visibleButtons = paging.getByRole('button')
  await current.focus()
  for (let index = 2; index < await visibleButtons.count(); index++) {
    await page.keyboard.press('Tab'); await expect(visibleButtons.nth(index)).toBeFocused()
  }
  await expect(next).toBeFocused()
  await page.keyboard.press('Enter'); await onPage(2)
  await visibleButtons.nth(1).focus(); await page.keyboard.press('Shift+Tab'); await expect(previous).toBeFocused()
  await page.keyboard.press('Space'); await onPage(1)
  await expect(list(page).locator('[data-list-page-summary] select')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  // Every actor/locale/viewport exercises a held new key and contextual empty recovery.
  let release: (() => void) | undefined
  const hold = new Promise<void>(resolve => { release = resolve })
  await page.route('**/query', async intercepted => {
    const query = intercepted.request().postDataJSON()
    if (query.entity === 'worker' && query.includeTotal) await hold
    await intercepted.continue()
  })
  try {
    await page.getByRole('group', { name: copy.listViews }).getByRole('button', { name: /^Archived workers/ }).click()
    await expect(list(page).locator('[data-list-skeleton]')).toHaveCount(5)
    await expect(footer(page).getByRole('status')).toHaveText(copy.loading)
    await expect(list(page).locator('[data-list-range]')).toHaveCount(0)
    const skeleton = list(page).locator('[data-list-skeleton]').first()
    await expect(skeleton.locator('td')).toHaveCount(await table.getByRole('columnheader').count())
    expect(Math.round((await skeleton.boundingBox())!.height)).toBe(actor === 'admin' ? 53 : 45)
    release!()
    await expect(list(page).getByRole('heading', { name: copy.noResults })).toBeVisible()
    await insideViewport(list(page).getByText(copy.listEmptyViewDescription))
    await expect(list(page).getByRole('button', { name: copy.clearSearchFilters })).toHaveCount(0)
    await page.getByRole('searchbox', { name: copy.search, exact: true }).fill('missing')
    await expect(list(page).getByText(copy.listEmptyFilteredDescription)).toBeVisible()
    await list(page).getByRole('button', { name: copy.clearSearchFilters }).click()
    await expect(list(page).getByText(copy.listEmptyViewDescription)).toBeVisible()
    expect(new URL(page.url()).searchParams.get('view')).toBe('empty')
    expect(new URL(page.url()).searchParams.has('search')).toBe(false)
    await page.getByRole('group', { name: copy.listViews }).getByRole('button', { name: /^All workers/ }).click()
    await expect(row).toBeVisible()
    await page.screenshot({ path: `${process.env.LIST_V2_OUTPUT}/polish-${width}-${actor}-${language}.png`, fullPage: true })
  } finally { release?.(); await page.unrouteAll({ behavior: 'wait' }) }
})

test('G6: held initial and new-query skeletons become results; filtered empty clears while preserving the configured view', async ({ page }) => {
  let release: (() => void) | undefined
  let hold = new Promise<void>(resolve => { release = resolve })
  await page.route('**/query', async intercepted => {
    const query = intercepted.request().postDataJSON()
    if (query.entity === 'worker' && query.includeTotal) await hold
    await intercepted.continue()
  })
  try {
    await gotoSDK(page, route)
    await expect(list(page).locator('[data-list-skeleton]')).toHaveCount(5)
    await expect(footer(page).getByRole('status')).toHaveText(en.loading)
    await expect(list(page).locator('[data-list-range]')).toHaveCount(0)
    release!(); await settled(page)
    await tab(page, 'empty'); await rows(page, { view: 'empty' })
    await expect(list(page).getByRole('heading', { name: en.noResults })).toBeVisible()
    await expect(list(page).getByText(en.listEmptyViewDescription)).toBeVisible()
    await expect(list(page).getByRole('button', { name: en.clearSearchFilters })).toHaveCount(0)
    await tab(page, 'active'); await rows(page, { view: 'active' })
    await page.getByRole('searchbox', { name: en.search, exact: true }).fill('no such worker')
    await expect(list(page).getByText(en.listEmptyFilteredDescription)).toBeVisible()
    await list(page).getByRole('button', { name: en.clearSearchFilters }).click()
    await rows(page, { view: 'active' })
    expect(new URL(page.url()).searchParams.get('view')).toBe('active')
    const original = await list(page).locator('tbody tr[data-row-id]').first().elementHandle()
    hold = new Promise<void>(resolve => { release = resolve })
    // A real row edit invalidates the list itself without refreshing authority (a new key).
    await list(page).getByRole('row').filter({ has: page.getByRole('link', { name: 'Worker 001', exact: true }) }).getByRole('button', { name: 'Actions for Worker 001', exact: true }).click()
    await page.getByRole('menuitem', { name: en.edit, exact: true }).click()
    const edit = page.getByRole('dialog')
    await edit.getByRole('textbox', { name: 'Name', exact: true }).fill('Worker 001 refreshed')
    await edit.getByRole('button', { name: en.save, exact: true }).click()
    await expect(footer(page).locator('[role="status"]')).toHaveText(en.loading)
    expect(await original!.evaluate(element => element.isConnected)).toBe(true)
    await expect(list(page).locator('[data-list-skeleton]')).toHaveCount(0)
    release!()
    await expect(edit).toHaveCount(0)
    await expect(footer(page).locator('[data-list-range]')).toHaveAttribute('role', 'status')
    expect(await original!.evaluate(element => element.isConnected)).toBe(true)
    await page.screenshot({ path: `${process.env.LIST_V2_OUTPUT}/polish-empty-recovery.png`, fullPage: true })
  } finally { release?.(); await page.unrouteAll({ behavior: 'wait' }) }
})

for (const width of [1440, 390]) for (const language of ['en', 'cs'] as const) {
  test(`#259 filter control geometry ${width} ${language}`, async ({ page, context }) => {
    const copy = language === 'cs' ? cs : en
    await page.setViewportSize({ width, height: 900 })
    await context.addInitScript(language => localStorage.setItem('console-language', language), language)
    await gotoSDK(page, route)
    await expect(list(page).locator('[data-list-range]')).toBeVisible()
    await page.getByRole('button', { name: copy.sortAndFilter, exact: true }).click()
    const filters = page.getByRole('group', { name: copy.sortAndFilter, exact: true })
    await page.evaluate(async () => { await document.fonts.ready })
    // Checkboxes/radios are choice indicators, not input-height text/select controls.
    const geometry = await filters.locator('input:not([type="checkbox"]):not([type="radio"]), select, button[role="combobox"]').evaluateAll(controls => controls.map(control => {
      const field = control.closest('form')!.firstElementChild!
      const cell = [...field.children].find(child => child.contains(control))!
      const rect = control.getBoundingClientRect()
      return { tag: control.tagName, name: control.getAttribute('aria-label'), top: rect.top, height: rect.height, row: cell.getBoundingClientRect().top }
    }))
    observations.push({ kind: 'filter-control-geometry', width, language, geometry })
    expect(geometry.length).toBeGreaterThanOrEqual(2)
    const standardHeight = (await filters.getByRole('textbox').first().boundingBox())!.height
    for (const control of geometry) expect.soft(Math.abs(control.height - standardHeight), JSON.stringify(control)).toBeLessThanOrEqual(1)
    for (const control of geometry) for (const neighbour of geometry.filter(item => Math.abs(item.row - control.row) <= 1)) {
      expect.soft(Math.abs(control.top - neighbour.top), `same grid row: ${JSON.stringify({ control, neighbour })}`).toBeLessThanOrEqual(1)
    }
  })

  test(`#259 trigger and panel labels ${width} ${language}`, async ({ page, context }) => {
    const expected = language === 'cs' ? { saved: 'Uložené pohledy', columns: 'Sloupce', filters: 'Filtry' } : { saved: 'Saved views', columns: 'Columns', filters: 'Filters' }
    await page.setViewportSize({ width, height: 900 })
    await context.addInitScript(language => localStorage.setItem('console-language', language), language)
    await gotoSDK(page, route)
    await expect(list(page).locator('[data-list-range]')).toBeVisible()
    const copy = language === 'cs' ? cs : en
    for (const [current, label] of [[copy.savedViewsMenu, expected.saved], [copy.listDisplay, expected.columns], [copy.sortAndFilter, expected.filters]]) {
      const trigger = page.getByRole('button', { name: current, exact: true })
      if (current !== copy.savedViewsMenu) await expect.soft(trigger).toHaveText(label, { timeout: 500 })
      else { await expect(trigger).toHaveText(''); await expect(trigger.locator('svg')).toHaveAttribute('aria-hidden', 'true') }
      await expect.soft(trigger).toHaveAccessibleName(label, { timeout: 500 })
      await expect(trigger).toHaveAttribute('title', label)
      await expect(trigger).toHaveAccessibleDescription(label)
    }
    const saved = page.getByRole('button', { name: copy.savedViewsMenu, exact: true })
    for (const key of ['Enter', 'Space']) {
      await saved.focus()
      await page.keyboard.press(key)
      const menu = page.getByRole('dialog', { name: copy.savedViews, exact: true })
      await expect(menu).toBeVisible()
      await expect(menu.getByRole('button')).toHaveText([copy.savedViewsSaveNew, copy.savedViewsClose, copy.savedViewsApplyView])
      await page.keyboard.press('Escape')
      await expect(menu).toBeHidden()
      await expect(saved).toBeFocused()
    }
    await page.getByRole('button', { name: copy.sortAndFilter, exact: true }).click()
    await expect.soft(page.getByRole('group', { name: copy.sortAndFilter, exact: true })).toHaveAccessibleName(expected.filters, { timeout: 500 })
  })
}

for (const width of [1440, 360]) for (const language of ['en', 'cs'] as const) {
  test(`#259 Columns icon ${width} ${language}`, async ({ page, context }) => {
    const copy = language === 'cs' ? cs : en
    await page.setViewportSize({ width, height: 900 })
    await context.addInitScript(language => localStorage.setItem('console-language', language), language)
    await gotoSDK(page, route)
    await settled(page)
    const trigger = page.getByRole('button', { name: copy.listDisplay, exact: true })
    await expect(trigger).toHaveAccessibleName(copy.listDisplay)
    await expect(trigger).toHaveAttribute('title', copy.listDisplay)
    await expect(trigger.locator('svg.lucide-columns-3')).toHaveCount(1)
    await expect(trigger.locator('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(await trigger.evaluate(button => button.firstElementChild?.tagName.toLowerCase())).toBe('svg')
  })
}

for (const width of [1440, 1024, 768, 390, 360]) for (const language of ['en', 'cs'] as const) {
  test(`#259 long Columns containment ${width} ${language}`, async ({ page, context }) => {
    const copy = language === 'cs' ? cs : en
    await page.setViewportSize({ width, height: 900 })
    await context.addInitScript(language => localStorage.setItem('console-language', language), language)
    // Reuse review1's real console-model probe: 30 hidden fields; Worker/D1 still supplies all rows.
    await page.route('**/console-model', async intercepted => {
      const response = await intercepted.fetch(); const body = await response.json()
      for (let index = 0; index < 30; index++) {
        const field = `probe_${index}`
        body.model.entities.worker.fields[field] = { ...body.model.entities.worker.fields.code }
        body.console.entities.worker.list.filter[field] = false
        body.model.entities.worker.listColumns.push(field)
        body.capabilities.entities.worker.readable.push(field)
        body.console.entities.worker.list.columns.push({ field, defaultVisible: false })
      }
      await intercepted.fulfill({ response, json: body })
    })
    await page.route('**/query', async intercepted => {
      const strip = (value: any): any => Array.isArray(value) ? value.filter(item => typeof item !== 'string' || !item.startsWith('probe_')).map(strip) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, strip(item)])) : value
      const response = await intercepted.fetch({ postData: JSON.stringify(strip(intercepted.request().postDataJSON())) })
      await intercepted.fulfill({ response })
    })
    await gotoSDK(page, route); await settled(page)
    await expect.poll(() => ids(page)).toEqual(expectedRows({}).slice(0, 10).map(row => row.id))
    const trigger = page.getByRole('button', { name: copy.listDisplay, exact: true })
    await trigger.focus(); await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: copy.listDisplayHeading, exact: true })
    await expect(dialog.getByRole('checkbox')).toHaveCount(36)
    await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))) })
    const bounds = await dialog.boundingBox()
    observations.push({ kind: 'long-columns-bounds', width, language, bounds })
    expect(bounds!.height).toBeLessThanOrEqual(675)
    await insideViewport(dialog)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const columnList = dialog.locator('[data-list-display-columns]')
    await expect(columnList).toHaveCount(1)
    const scrolling = await columnList.evaluate(element => ({ client: element.clientHeight, scroll: element.scrollHeight, overflow: getComputedStyle(element).overflowY }))
    expect(scrolling.scroll).toBeGreaterThan(scrolling.client)
    expect(scrolling.overflow).toBe('auto')
    const compact = dialog.getByRole('checkbox', { name: copy.listDisplayCompact, exact: true })
    const reset = dialog.getByRole('button', { name: copy.listDisplayReset, exact: true })
    await insideViewport(compact); await insideViewport(reset)
    await columnList.getByRole('checkbox').last().focus()
    expect(await columnList.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    await insideViewport(columnList.getByRole('checkbox').last())
    await insideViewport(compact); await insideViewport(reset)
    await compact.click(); await expect(compact).toBeChecked()
    await reset.click(); await expect(compact).not.toBeChecked()
    await page.keyboard.press('Escape'); await expect(trigger).toBeFocused()
  })
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 360, height: 800 }]) for (const language of ['en', 'cs'] as const) for (const state of ['populated-list', 'Filters-open', 'Columns-open', 'access-menu-open'] as const) test(`SDK preview: ${viewport.width}x${viewport.height} ${language} ${state}`, async ({ page, context }, testInfo) => {
  const copy = language === 'cs' ? cs : en
  await page.setViewportSize(viewport)
  await context.addInitScript(language => localStorage.setItem('console-language', language), language)
  await gotoSDK(page, route); await settled(page)
  if (state === 'Filters-open') {
    await page.getByRole('button', { name: copy.sortAndFilter, exact: true }).click()
    await expect(page.getByRole('group', { name: copy.sortAndFilter, exact: true })).toBeVisible()
  }
  if (state === 'Columns-open') {
    await page.getByRole('button', { name: copy.listDisplay, exact: true }).click()
    await expect(page.getByRole('dialog', { name: copy.listDisplayHeading })).toBeVisible()
  }
  if (state === 'access-menu-open') {
    const trigger = page.getByRole('row').filter({ has: page.getByRole('link', { name: 'Worker 002', exact: true }) }).getByRole('button', { name: new RegExp(copy.rowAccessActions) })
    await trigger.click()
    await expect(page.getByRole('menu')).toBeVisible()
  }
  await captureSDK(page, state, language, testInfo)
})


// #266: adapted from wb261-select/measure.ts. Native Chromium selects expose
// their full selected text through the UA shadow tree. The painted arrow has no
// DOM glyph box: its reserved gutter is checked in full and clicked at center.
async function pageSizeGeometry(select: Locator, cdp: CDPSession) {
  const geometry = await select.evaluate((element: HTMLSelectElement) => {
    const rect = (element: Element) => element.getBoundingClientRect().toJSON()
    const style = getComputedStyle(element)
    const box = rect(element)
    const clips = [{ name: 'viewport', clipsX: true, clipsY: true, box: { left: 0, right: innerWidth, top: 0, bottom: innerHeight } }]
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const css = getComputedStyle(parent), bounds = rect(parent)
      const paint = /paint|strict|content/.test(css.contain)
      const clipsX = /auto|scroll|hidden|clip/.test(css.overflowX) || paint
      const clipsY = /auto|scroll|hidden|clip/.test(css.overflowY) || paint
      if (clipsX || clipsY) clips.push({ name: `${parent.tagName}.${parent.className}`, clipsX, clipsY, box: {
        left: bounds.left + parseFloat(css.borderLeftWidth), right: bounds.right - parseFloat(css.borderRightWidth),
        top: bounds.top + parseFloat(css.borderTopWidth), bottom: bounds.bottom - parseFloat(css.borderBottomWidth),
      } })
    }
    const outline = style.outlineStyle === 'none' ? 0 : Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset))
    const ring = Math.max(0, ...style.boxShadow.split(/,(?![^()]*\))/).filter(shadow => !shadow.includes('inset')).map(shadow => {
      const lengths = Array.from(shadow.matchAll(/(-?[\d.]+)px/g), match => Number(match[1]))
      return lengths.length >= 4 ? lengths[3] : 0
    }))
    const extent = Math.max(outline, ring)
    return { box, clips, focusBox: { left: box.left - extent, right: box.right + extent, top: box.top - extent, bottom: box.bottom + extent },
      extent, focusVisible: element.matches(':focus-visible'), focused: document.activeElement === element,
      value: element.value, text: element.selectedOptions[0].text, borderRight: parseFloat(style.borderRightWidth), rootFont: getComputedStyle(document.documentElement).fontSize, dpr: devicePixelRatio }
  })
  const documentNode = await cdp.send('DOM.getDocument', { depth: -1, pierce: true })
  type Node = { nodeName: string; nodeId: number; attributes?: string[]; children?: Node[]; shadowRoots?: Node[] }
  const find = (node: Node, predicate: (node: Node) => boolean): Node | undefined => predicate(node) ? node : [...node.children ?? [], ...node.shadowRoots ?? []].map(child => find(child, predicate)).find(Boolean)
  const native = find(documentNode.root, node => node.nodeName === 'SELECT')!
  const inner = find(native, node => !!node.attributes?.includes('-internal-select-inner-element'))!
  const resolved = await cdp.send('DOM.resolveNode', { nodeId: inner.nodeId })
  const response = await cdp.send('Runtime.callFunctionOn', { objectId: resolved.object.objectId, returnByValue: true, functionDeclaration: `function() {
    const range = document.createRange(); range.selectNodeContents(this);
    return { box: this.getBoundingClientRect().toJSON(), text: range.getBoundingClientRect().toJSON(), content: this.textContent };
  }` })
  const nativeText = response.result.value as { box: { left: number; right: number; top: number; bottom: number }; text: { left: number; right: number; top: number; bottom: number }; content: string }
  return { ...geometry, nativeText, caret: { left: nativeText.box.right, right: geometry.box.right - geometry.borderRight, top: geometry.box.top, bottom: geometry.box.bottom } }
}

for (const language of ['en', 'cs'] as const) for (const width of [320, 360, 390]) for (const font of [16, 32]) for (const offered of ['10', 'widest'] as const) test(`page-size fit: ${language} ${width}px font ${font} value ${offered}`, async ({ page, context, browser }, info) => {
  const copy = language === 'cs' ? cs : en
  await page.setViewportSize({ width, height: width === 320 ? 1000 : 844 })
  await context.addInitScript(language => localStorage.setItem('console-language', language), language)
  // Same high-page fixture as the measurement harness and #264 boundary cases.
  await page.route('**/query', async intercepted => {
    const query = intercepted.request().postDataJSON()
    if (query.entity !== 'worker' || !query.includeTotal) return intercepted.continue()
    const response = await intercepted.fetch({ postData: JSON.stringify({ ...query, offset: 0 }) })
    await intercepted.fulfill({ response, json: { ...await response.json(), total: 10010 } })
  })
  await gotoSDK(page, `${route}?page=1000`); await settled(page)
  await page.evaluate(font => { document.documentElement.style.fontSize = `${font}px` }, font)
  const select = footer(page).getByRole('combobox', { name: copy.rowsPerPage, exact: true })
  await layoutDiagnostics(select, true)
  // Read the real offered strings and measure their rendered text, per locale
  // and font. Do not assume that the largest numeric option is the widest.
  const options = await select.evaluate((element: HTMLSelectElement) => {
    const probe = document.createElement('span')
    probe.style.cssText = 'position:fixed;visibility:hidden;white-space:pre'
    probe.style.font = getComputedStyle(element).font
    document.body.append(probe)
    try { return Array.from(element.options, option => {
      probe.textContent = option.text
      const range = document.createRange(); range.selectNodeContents(probe)
      return { value: option.value, text: option.text, width: range.getBoundingClientRect().width }
    }) } finally { probe.remove() }
  })
  const value = offered === '10' ? '10' : options.reduce((a, b) => a.width >= b.width ? a : b).value
  if (offered === 'widest') {
    await select.selectOption(value)
    await expect(select).toHaveValue(value)
    // Page-size changes reset the page. Return to the supported offset bound
    // so Previous and Next are both focusable for the widest selected option.
    await gotoSDK(page, `${route}?page=${Math.floor(9990 / Number(value)) + 1}&pageSize=${value}`); await settled(page)
    await page.evaluate(font => { document.documentElement.style.fontSize = `${font}px` }, font)
  }
  await expect(select).toHaveValue(value)
  const cdp = await context.newCDPSession(page)
  const paging = footer(page).locator('[data-list-paging]')
  for (const state of ['default', 'Previous', 'Next', 'selectFocused'] as const) {
    await paging.scrollIntoViewIfNeeded()
    if (state === 'default') await select.evaluate(element => (element as HTMLElement).blur())
    else if (state === 'selectFocused') {
      // Real Tab from the preceding focusable DOM control, as in measure.ts.
      await select.evaluate(element => {
        const controls = Array.from(document.querySelectorAll<HTMLElement>('button,a[href],input,select,textarea,[tabindex]')).filter(control => control.tabIndex >= 0 && !control.hasAttribute('disabled') && control.getBoundingClientRect().width > 0)
        controls[controls.indexOf(element as HTMLElement) - 1].focus()
      })
      await page.keyboard.press('Tab'); await expect(select).toBeFocused()
    } else {
      const button = paging.getByRole('button', { name: state === 'Previous' ? copy.previousPage : copy.nextPage, exact: true })
      await expect(button).toBeEnabled(); await button.focus(); await expect(button).toBeFocused()
    }
    await layoutDiagnostics(select, true)
    const geometry = await pageSizeGeometry(select, cdp)
    const key = `${language}-${width}-${font}-${value}-${state}`
    const png = `${process.env.LIST_V2_OUTPUT}/page-size-${key}.png`
    await page.screenshot({ path: png, animations: 'disabled' })
    const sample = { sha: provenanceSHA(), locale: language, viewport: page.viewportSize(), font, offered, value, options, state, browser: browser.version(), geometry, png }
    record('pageSize', key, sample)
    observations.push({ kind: 'page-size', ...sample })
    expect(geometry.nativeText.content).toBe(geometry.text)
    expect(geometry.caret.right - geometry.caret.left).toBeGreaterThan(0)
    if (state === 'selectFocused') { expect(geometry.focused).toBe(true); expect(geometry.focusVisible).toBe(true); expect(geometry.extent).toBeGreaterThan(0) }
    const boxes = { trigger: geometry.box, focus: geometry.focusBox, text: geometry.nativeText.text, caret: geometry.caret }
    for (const [name, box] of Object.entries(boxes)) for (const clip of geometry.clips) {
      if (clip.clipsX) { expect.soft(box.left, `${key} ${name} left vs ${clip.name}`).toBeGreaterThanOrEqual(clip.box.left); expect.soft(box.right, `${key} ${name} right vs ${clip.name}`).toBeLessThanOrEqual(clip.box.right) }
      if (clip.clipsY) { expect.soft(box.top, `${key} ${name} top vs ${clip.name}`).toBeGreaterThanOrEqual(clip.box.top); expect.soft(box.bottom, `${key} ${name} bottom vs ${clip.name}`).toBeLessThanOrEqual(clip.box.bottom) }
    }
    // Text must also fit the native select's own inner overflow clip.
    for (const edge of ['left', 'top'] as const) expect.soft(geometry.nativeText.text[edge], `${key} native text ${edge}`).toBeGreaterThanOrEqual(geometry.nativeText.box[edge])
    for (const edge of ['right', 'bottom'] as const) expect.soft(geometry.nativeText.text[edge], `${key} native text ${edge}`).toBeLessThanOrEqual(geometry.nativeText.box[edge])
    for (const [name, box] of Object.entries({ trigger: geometry.box, caret: geometry.caret })) {
      await page.mouse.click((box.left + box.right) / 2, (box.top + box.bottom) / 2)
      expect.soft(await select.evaluate(element => element.matches(':open')), `${key} ${name} click opens`).toBe(true)
      // macOS native menus ignore synthetic Escape; Tab reliably dismisses.
      await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab')
    }
    if (state === 'selectFocused') {
      await select.focus(); await page.keyboard.press('Space')
      expect(await select.evaluate(element => element.matches(':open'))).toBe(true)
      await page.keyboard.press('Tab')
    }
  }
  // Explicit programmatic change, not a claim of native menu key selection.
  await select.selectOption('20')
  await expect(select).toHaveValue('20')
  await expect(page.locator('tbody tr')).toHaveCount(20)
  await expect.poll(() => new URL(page.url()).searchParams.get('page')).not.toBe('1000')
  await info.attach('page-size-options.json', { body: JSON.stringify({ language, font, offered, value, options }), contentType: 'application/json' })
  await cdp.detach()
})
// #265: reuse the reachability probe's real Tab path and raw CSS outline /
// shadow envelope. DOM visibility alone misses clipping by the tabs scroller.
async function viewTabGeometry(target: Locator) {
  return target.evaluate(element => {
    const tab = element as HTMLElement
    const group = tab.parentElement!
    const box = tab.getBoundingClientRect()
    const style = getComputedStyle(tab)
    const outline = style.outlineStyle === 'none' ? 0 : Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset))
    const extent = { left: outline, right: outline, top: outline, bottom: outline }
    for (const shadow of style.boxShadow.replace(/(?:rgba?|hsla?|oklab|oklch|color)\([^)]*\)/g, 'COLOR').split(',')) {
      if (shadow.includes('inset') || shadow === 'none') continue
      const [x, y, blur = 0, spread = 0] = [...shadow.matchAll(/(-?[\d.]+)px/g)].map(match => Number(match[1]))
      if (x === undefined || y === undefined) continue
      const radius = spread + 1.5 * blur
      extent.left = Math.max(extent.left, radius - x); extent.right = Math.max(extent.right, radius + x)
      extent.top = Math.max(extent.top, radius - y); extent.bottom = Math.max(extent.bottom, radius + y)
    }
    const ring = { left: box.left - extent.left, right: box.right + extent.right, top: box.top - extent.top, bottom: box.bottom + extent.bottom }
    const clip = { left: 0, right: innerWidth, top: 0, bottom: innerHeight }
    for (let parent = tab.parentElement; parent; parent = parent.parentElement) {
      const css = getComputedStyle(parent), rect = parent.getBoundingClientRect()
      if (/auto|scroll|hidden|clip/.test(css.overflowX)) { clip.left = Math.max(clip.left, rect.left + parseFloat(css.borderLeftWidth)); clip.right = Math.min(clip.right, rect.right - parseFloat(css.borderRightWidth)) }
      if (/auto|scroll|hidden|clip/.test(css.overflowY)) { clip.top = Math.max(clip.top, rect.top + parseFloat(css.borderTopWidth)); clip.bottom = Math.min(clip.bottom, rect.bottom - parseFloat(css.borderBottomWidth)) }
    }
    const labelNode = tab.firstChild!
    const label = document.createRange(); label.selectNodeContents(labelNode)
    const badge = tab.lastElementChild as HTMLElement
    const badgeText = document.createRange(); badgeText.selectNodeContents(badge)
    const labelStyle = getComputedStyle(labelNode instanceof Element ? labelNode : tab)
    const badgeStyle = getComputedStyle(badge)
    const text = { label: label.toString(), badge: badgeText.toString(), labelFont: labelStyle.fontSize, badgeFont: badgeStyle.fontSize,
      labelOverflow: labelStyle.textOverflow, badgeOverflow: badgeStyle.textOverflow,
      labelWidth: labelNode instanceof HTMLElement ? labelNode.clientWidth : null, labelScrollWidth: labelNode instanceof HTMLElement ? labelNode.scrollWidth : null,
      badgeWidth: badge.clientWidth, badgeScrollWidth: badge.scrollWidth }
    const labelLines = [...label.getClientRects()].map(rect => rect.toJSON())
    return { box: box.toJSON(), ring, label: label.getBoundingClientRect().toJSON(), labelLines, badge: badge.getBoundingClientRect().toJSON(), badgeText: badgeText.getBoundingClientRect().toJSON(), text, clip, outline: style.outline, boxShadow: style.boxShadow,
      focused: document.activeElement === tab, focusVisible: tab.matches(':focus-visible'), scrollLeft: group.scrollLeft, clientWidth: group.clientWidth, scrollWidth: group.scrollWidth,
      window: { x: scrollX, y: scrollY }, font: getComputedStyle(document.documentElement).fontSize, dpr: devicePixelRatio }
  })
}

for (const language of ['en', 'cs'] as const) for (const width of [768, 390, 360]) for (const font of [16, 32]) for (const state of ['focus', 'enter', 'reload'] as const) {
  test(`#265 tabs reveal: ${language} ${width}px ${font}px ${state}`, async ({ page, context, browser }, info) => {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await context.addInitScript(({ language, font }) => {
      localStorage.setItem('console-language', language)
      const apply = () => { if (document.documentElement) document.documentElement.style.fontSize = `${font}px` }
      apply(); new MutationObserver(apply).observe(document, { childList: true })
    }, { language, font })
    const group = list(page).locator('[data-list-slot="tabs"] [role="group"]')
    const tabs = group.getByRole('button'), last = tabs.last()
    const settleTabs = async () => {
      await expect(tabs).toHaveCount(5)
      await expect(list(page).locator('[data-list-range]')).toBeVisible()
      await page.evaluate(async () => {
        await document.fonts.ready
        await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))
        await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())))
      })
    }
    await gotoSDK(page, state === 'reload' ? `${route}?view=invited` : route)
    await settleTabs()
    const initialWindow = { x: 0, y: 0 }
    // Render the original tab markup/classes at intrinsic width, using this
    // browser's font metrics. Exact equality stays portable across Mac/Linux.
    const baseSize = async (target: Locator = last) => target.evaluate(element => {
      const reference = document.createElement('button')
      reference.type = 'button'
      reference.setAttribute('aria-pressed', element.getAttribute('aria-pressed')!)
      reference.className = 'flex min-h-12 shrink-0 items-center gap-2 border-b-2 border-transparent text-sm text-muted-foreground aria-pressed:border-primary aria-pressed:font-semibold aria-pressed:text-foreground'
      reference.append(document.createTextNode(element.firstChild!.textContent!))
      const count = element.querySelector('.tabular-nums')
      if (count) {
        const badge = document.createElement('span')
        badge.className = 'rounded bg-muted px-1.5 py-0.5 text-xs tabular-nums'
        badge.textContent = count.textContent
        reference.append(badge)
      }
      Object.assign(reference.style, { position: 'fixed', left: '0', top: '0', width: 'max-content', visibility: 'hidden', pointerEvents: 'none' })
      element.parentElement!.append(reference)
      const { width, height } = reference.getBoundingClientRect()
      reference.remove()
      return { width, height }
    })
    if (state === 'focus') {
      const path = `${output}/${language}-${width}-${font}-initial.png`
      await page.screenshot({ path, animations: 'disabled' })
      record('tabsInitial', `${language}-${width}-${font}`, { screenshot: path, locale: language, viewport: page.viewportSize(), rootFont: font, browser: browser.version(), geometry: await viewTabGeometry(last) })
    }
    const check = async (phase: string, focus = false, target: Locator = last, expectedLabel = 'Pending invitations', expectedBadge = '1') => {
      await settleTabs()
      const geometry = await viewTabGeometry(target)
      const key = `${language}-${width}-${font}-${state}-${phase}`
      const path = `${output}/${key}.png`
      await page.screenshot({ path, animations: 'disabled' })
      record('tabsReveal', key, { locale: language, viewport: page.viewportSize(), rootFont: font, state, phase, browser: browser.version(), screenshot: path, ...geometry })
      await info.attach(`${key}.json`, { body: JSON.stringify(geometry), contentType: 'application/json' })
      expect.soft(geometry.font).toBe(`${font}px`)
      expect.soft(geometry.window).toEqual(initialWindow)
      for (const [name, box] of Object.entries({ tab: geometry.box, ring: geometry.ring, label: geometry.label, badge: geometry.badge, badgeText: geometry.badgeText, ...Object.fromEntries(geometry.labelLines.map((line, index) => [`labelLine${index}`, line])) })) {
        expect.soft(box.left, `${phase} ${name} left`).toBeGreaterThanOrEqual(geometry.clip.left)
        expect.soft(box.right, `${phase} ${name} right`).toBeLessThanOrEqual(geometry.clip.right)
        expect.soft(box.top, `${phase} ${name} top`).toBeGreaterThanOrEqual(geometry.clip.top)
        expect.soft(box.bottom, `${phase} ${name} bottom`).toBeLessThanOrEqual(geometry.clip.bottom)
      }
      expect.soft(geometry.text.label).toBe(expectedLabel)
      expect.soft(geometry.text.badge).toBe(expectedBadge)
      expect.soft(geometry.text.labelOverflow).not.toBe('ellipsis')
      expect.soft(geometry.text.badgeOverflow).not.toBe('ellipsis')
      expect.soft(geometry.text.labelFont).toBe(`${font * .875}px`)
      expect.soft(geometry.text.badgeFont).toBe(`${font * .75}px`)
      expect.soft(geometry.text.badgeScrollWidth).toBeLessThanOrEqual(geometry.text.badgeWidth)
      if (geometry.text.labelWidth !== null) expect.soft(geometry.text.labelScrollWidth).toBeLessThanOrEqual(geometry.text.labelWidth)
      // Base probe dimensions: fitting tabs retain their exact box; only an
      // oversized individual tab may become narrower and wrap its label.
      const reference = await baseSize(target)
      const available = await group.evaluate(element => element.clientWidth - parseFloat(getComputedStyle(element).paddingLeft) - parseFloat(getComputedStyle(element).paddingRight))
      if (reference.width <= available) expect.soft({ width: geometry.box.width, height: geometry.box.height }).toEqual(reference)
      expect.soft(geometry.scrollWidth).toBeGreaterThan(geometry.clientWidth)
      expect.soft(await page.locator('html').getAttribute('lang')).toBe(language)
      if (focus) { expect.soft(geometry.focused).toBe(true); expect.soft(geometry.focusVisible).toBe(true) }
    }
    if (state === 'reload') {
      await expect(last).toHaveAttribute('aria-pressed', 'true')
      await check('initial-selected')
      await reloadSDK(page); await expect(last).toHaveAttribute('aria-pressed', 'true')
      await check('reloaded-selected')
    } else {
      // Start at the body and use the browser's actual sequential focus order.
      for (let index = 0; index < 100 && !await last.evaluate(element => element === document.activeElement); index++) await page.keyboard.press('Tab')
      await expect(last).toBeFocused()
      if (state === 'focus') {
        await check('tab', true)
        await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab')
        await expect(last).toBeFocused(); await check('shift-tab', true)
      } else {
        await page.keyboard.press('Enter'); await expect(last).toHaveAttribute('aria-pressed', 'true')
        expect(new URL(page.url()).searchParams.get('view')).toBe('invited')
        await check('activated', true)
        await page.goBack(); await expect(tabs.first()).toHaveAttribute('aria-pressed', 'true')
        await check('history-back-selected', false, tabs.first(), 'All workers', '47')
        await page.goForward(); await expect(last).toHaveAttribute('aria-pressed', 'true')
        await check('history-selected')
        await page.goBack(); await expect(tabs.first()).toHaveAttribute('aria-pressed', 'true')
        for (let index = 0; index < 100 && !await last.evaluate(element => element === document.activeElement); index++) await page.keyboard.press('Tab')
        await page.keyboard.press('Space'); await expect(last).toHaveAttribute('aria-pressed', 'true')
        await check('space-selected', true)
        await page.goBack(); await expect(tabs.first()).toHaveAttribute('aria-pressed', 'true')
        await last.click(); await expect(last).toHaveAttribute('aria-pressed', 'true')
        await check('click-selected')
      }
    }
  })
}

// #265: counts must not displace a tab focused while the real query is pending.
for (const language of ['en', 'cs'] as const) for (const font of [16, 32]) {
  test(`#265 tabs focus-pending: ${language} 360px ${font}px`, async ({ page, context, browser }, info) => {
    await page.setViewportSize({ width: 360, height: 900 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await context.addInitScript(({ language, font }) => {
      localStorage.setItem('console-language', language)
      const apply = () => { if (document.documentElement) document.documentElement.style.fontSize = `${font}px` }
      apply(); new MutationObserver(apply).observe(document, { childList: true })
    }, { language, font })
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    await page.route('**/query', async intercepted => {
      const response = await intercepted.fetch()
      await held
      await intercepted.fulfill({ response })
    })
    const group = list(page).locator('[data-list-slot="tabs"] [role="group"]')
    const tabs = group.getByRole('button'), last = tabs.last()
    const check = async (phase: string) => {
      const geometry = await viewTabGeometry(last)
      const key = `${language}-360-${font}-focus-pending-${phase}`
      const path = `${output}/${key}.png`
      await page.screenshot({ path, animations: 'disabled' })
      record('tabsFocusPending', key, { locale: language, viewport: page.viewportSize(), rootFont: font, browser: browser.version(), phase, screenshot: path, ...geometry })
      await info.attach(`${key}.json`, { body: JSON.stringify(geometry), contentType: 'application/json' })
      expect.soft(geometry.focused).toBe(true)
      expect.soft(geometry.focusVisible).toBe(true)
      expect.soft(geometry.font).toBe(`${font}px`)
      expect.soft(geometry.window).toEqual({ x: 0, y: 0 })
      for (const [name, box] of Object.entries({ tab: geometry.box, ring: geometry.ring, label: geometry.label, ...(phase === 'after-counts' ? { badge: geometry.badge, badgeText: geometry.badgeText } : {}), ...Object.fromEntries(geometry.labelLines.map((line, index) => [`labelLine${index}`, line])) })) {
        expect.soft(box.left, `${phase} ${name} left`).toBeGreaterThanOrEqual(geometry.clip.left)
        expect.soft(box.right, `${phase} ${name} right`).toBeLessThanOrEqual(geometry.clip.right)
        expect.soft(box.top, `${phase} ${name} top`).toBeGreaterThanOrEqual(geometry.clip.top)
        expect.soft(box.bottom, `${phase} ${name} bottom`).toBeLessThanOrEqual(geometry.clip.bottom)
      }
    }
    try {
      await gotoSDK(page, route)
      await expect(tabs).toHaveCount(5)
      await expect(group.locator('.tabular-nums')).toHaveCount(0)
      await expect(list(page).locator('[aria-busy="true"]')).toBeVisible()
      await page.evaluate(async () => { await document.fonts.ready })
      for (let index = 0; index < 100 && !await last.evaluate(element => element === document.activeElement); index++) await page.keyboard.press('Tab')
      await expect(last).toBeFocused()
      await expect(tabs.first()).toHaveAttribute('aria-pressed', 'true')
      await check('before-counts')
      release()
      await expect(last.locator('.tabular-nums')).toHaveText('1')
      await expect(list(page).locator('[data-list-range]')).toBeVisible()
      await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
      await expect(tabs.first()).toHaveAttribute('aria-pressed', 'true')
      await expect(last).toHaveAttribute('aria-pressed', 'false')
      await check('after-counts')
      await expect(page.locator('html')).toHaveAttribute('lang', language)
      expect(new URL(page.url()).searchParams.get('view')).toBeNull()
    } finally { release(); await page.unrouteAll({ behavior: 'wait' }) }
  })
}

for (const width of [1440, 900, 390]) for (const language of ['en', 'cs'] as const) test(`#292 column order ${width} ${language}`, async ({ page, context }) => {
  const copy = language === 'cs' ? cs : en
  await page.setViewportSize({ width, height: 900 })
  await context.addInitScript(language => localStorage.setItem('console-language', language), language)
  await gotoSDK(page, route); await settled(page)
  const expectedIds = expectedRows({}).slice(0, 10).map(row => row.id)
  await expect.poll(() => ids(page)).toEqual(expectedIds)
  const headers = list(page).getByRole('columnheader')
  const initial = await headers.allTextContents()
  const initialCells = await list(page).locator('tbody tr').first().getByRole('cell').allTextContents()
  const trigger = page.getByRole('button', { name: copy.listDisplay, exact: true })
  await trigger.focus(); await page.keyboard.press('Enter')
  const menu = page.getByRole('dialog', { name: copy.listDisplayHeading, exact: true })
  const checks = menu.locator('[data-list-display-columns]').getByRole('checkbox')
  const first = checks.first()
  await expect(first).toBeFocused()
  const column = (await first.locator('..').textContent())!.trim()
  const up = menu.getByRole('button', { name: copy.listDisplayMoveUp.replace('{{column}}', column), exact: true })
  const down = menu.getByRole('button', { name: copy.listDisplayMoveDown.replace('{{column}}', column), exact: true })
  await expect(up).toBeDisabled()
  await expect(menu.getByRole('button', { name: copy.listDisplayMoveDown.replace('{{column}}', copy.rowAccess), exact: true })).toBeDisabled()
  // Use the same Tab/Enter/Space path available to users, including a real DOM move.
  await page.keyboard.press('Tab'); await expect(down).toBeFocused()
  await page.keyboard.press('Enter'); await expect(down).toBeFocused()
  const reordered = [...initial]; [reordered[1], reordered[2]] = [reordered[2], reordered[1]]
  await expect(headers).toHaveText(reordered)
  const reorderedCells = [...initialCells]; [reorderedCells[1], reorderedCells[2]] = [reorderedCells[2], reorderedCells[1]]
  await expect(list(page).locator('tbody tr').first().getByRole('cell')).toHaveText(reorderedCells)
  await page.keyboard.press('Shift+Tab'); await expect(up).toBeFocused()
  await page.keyboard.press('Space'); await expect(up).toBeDisabled(); await expect(down).toBeFocused()
  await expect(headers).toHaveText(initial)
  await down.click()
  const hidden = menu.locator('[data-list-display-columns]').getByRole('checkbox', { checked: false })
  await expect(hidden).toHaveCount(1)
  await hidden.click()
  await menu.getByRole('button', { name: copy.listDisplayReset, exact: true }).click()
  await expect(headers).toHaveText(initial)
  await expect(list(page).locator('tbody tr').first().getByRole('cell')).toHaveText(initialCells)
  // Primary record links and the trailing Actions column survive every move and reset.
  await expect.poll(() => ids(page)).toEqual(expectedIds)
  await insideViewport(menu)
  await page.keyboard.press('Escape'); await expect(trigger).toBeFocused()
})
