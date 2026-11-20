import { test, expect, type Page, type Locator } from '@playwright/test'
import setup from './runtime/setup'
import { workers, expectedRows, expectedCounts, type Selection } from './runtime/list-v2-data'
import { capture, provenance, result, record } from './list-v2-evidence'
import en from '../src/locales/en.json' with { type: 'json' }
import cs from '../src/locales/cs.json' with { type: 'json' }

let observations: unknown[] = []
let stop: (() => Promise<void>) | undefined
const route = '/o/org-a/e/worker'
const labels: Record<string, string> = { all: 'All workers', active: 'Active workers', inactive: 'Inactive workers', empty: 'Archived workers', invited: 'Pending invitations' }
test.beforeAll(async ({ browser }) => { stop = await setup({ worker: 'list-v2-worker.ts', seed: 'list-v2-seed.ts' }); provenance(browser.version()) })
test.afterAll(async () => { await stop?.() })
test.beforeEach(async ({ context, page }) => { observations = []; page.on('response', response => { if (new URL(response.url()).pathname === '/query') void response.json().then(body => observations.push({ kind: 'query', request: response.request().postDataJSON(), status: response.status(), response: body })).catch(() => {}) }); await context.addInitScript(() => localStorage.setItem('console-language', 'en')) })
test.afterEach(async ({ page }, info) => { observations.push({ kind: 'final', url: page.url(), ids: await ids(page).catch(() => []), footer: await footer(page).textContent().catch(() => null), tabs: await list(page).locator('[data-list-slot="tabs"]').textContent().catch(() => null) }); record('functionalEvidence', info.title, observations); result(info) })
const list = (page: Page) => page.locator('[data-slot="list-page"]')
const footer = (page: Page) => list(page).locator('footer')
const panel = (page: Page) => page.getByRole('group', { name: en.sortAndFilter, exact: true })
const savedTrigger = (page: Page) => page.getByRole('region', { name: en.savedViews, exact: true }).locator('button[aria-haspopup="dialog"]')
const savedMenu = (page: Page) => page.getByRole('dialog', { name: en.savedViews, exact: true })
// Measure the painted ring against the scrollport's inner border and opaque Actions.
async function focusClear(control: Locator, allowOversized = false) {
  await expect(control).toBeFocused()
  const geometry = () => control.evaluate(element => {
    const port = element.closest('[data-slot="table-container"]') as HTMLElement
    const box = element.getBoundingClientRect(); const clip = port.getBoundingClientRect()
    const actions = port.querySelector('th.sticky')?.getBoundingClientRect()
    return { name: element.getAttribute('aria-label') ?? element.textContent, left: box.left, right: box.right, clipLeft: clip.left + port.clientLeft, clipRight: clip.left + port.clientLeft + port.clientWidth, actionsLeft: actions?.left, scrollLeft: port.scrollLeft }
  })
  try { await expect.poll(() => control.evaluate((element, allowOversized) => {
    const port = element.closest('[data-slot="table-container"]') as HTMLElement
    const box = element.getBoundingClientRect()
    const clip = port.getBoundingClientRect()
    const actions = port.querySelector('th.sticky')?.getBoundingClientRect()
    const left = clip.left + port.clientLeft
    const right = Math.min(left + port.clientWidth, actions?.left ?? Infinity)
    // At 200% text some controls are wider than the entire clear interval.
    // Nearest-edge reveal must leave that interval covered without oscillation.
    if (allowOversized && box.width + 6 > right - left && box.left - 3 <= left && box.right + 3 >= right) return { left: 0, right: 0 }
    return { left: Math.max(0, left - (box.left - 3)), right: Math.max(0, box.right + 3 - right) }
  }, allowOversized), { message: 'full 3px ring clears both clip edges and sticky Actions (oversized: nearest edge)' }).toEqual({ left: 0, right: 0 })
  } catch (error) { throw new Error(`${String(error)}\nGeometry: ${JSON.stringify(await geometry())}`) }
  observations.push({ kind: 'focused-ring', ...await geometry() })
}

test('focus reveal: Code Tab at zero clears opaque Actions', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(route); await settled(page)
  const port = list(page).locator('[data-slot="table-container"]')
  await port.evaluate(element => { element.scrollLeft = 0 })
  const name = list(page).getByRole('columnheader', { name: /Name/ }).getByRole('button').first()
  const code = list(page).getByRole('columnheader', { name: /Code/ }).getByRole('button').first()
  await name.focus()
  // Name's filter follows its sort control in the natural keyboard order.
  for (let index = 0; index < 4 && !await code.evaluate(element => element === document.activeElement); index++) await page.keyboard.press('Tab')
  await focusClear(code)
})

for (const width of [360, 390, 1440]) for (const language of ['en', 'cs'] as const) for (const compact of [false, true]) for (const fontSize of [16, 32]) test(`focus reveal: keyboard ${width} ${language} ${compact ? 'compact' : 'comfortable'} text ${fontSize}`, async ({ page, context }) => {
  const copy = language === 'cs' ? cs : en
  await page.setViewportSize({ width, height: 844 })
  await context.addInitScript(language => localStorage.setItem('console-language', language), language)
  await page.goto(route); await settled(page)
  if (compact) {
    await page.getByRole('button', { name: copy.listDisplay, exact: true }).click()
    await page.getByRole('checkbox', { name: copy.listDisplayCompact, exact: true }).click()
    await page.keyboard.press('Escape')
  }
  await page.evaluate(async fontSize => { document.documentElement.style.fontSize = `${fontSize}px`; await document.fonts.ready }, fontSize)
  const port = list(page).locator('[data-slot="table-container"]')
  // Access metadata arrives independently of the list. Freeze the traversal
  // only once all row controls have joined the enabled keyboard sequence.
  await expect(port.getByRole('button', { name: new RegExp(copy.rowAccessActions) })).toHaveCount(10)
  await expect.poll(() => port.locator('tbody button:disabled').count()).toBe(0)
  const controls = port.locator('button:enabled, a[href], input:enabled, select:enabled')
  expect(await controls.count()).toBeGreaterThan(25)
  await expect.poll(() => port.evaluate(element => parseFloat(getComputedStyle(element).scrollPaddingInlineEnd) - element.querySelector('[data-pinned-actions]')!.getBoundingClientRect().width)).toBe(3)
  expect(await port.evaluate(element => getComputedStyle(element).scrollPaddingInlineStart)).toBe('3px')
  for (const offset of [0, 0.5, 1]) {
    await port.focus()
    await port.evaluate((element, offset) => { element.scrollLeft = (element.scrollWidth - element.clientWidth) * offset }, offset)
    for (const control of await controls.all()) {
      await page.keyboard.press('Tab')
      await expect(control).toBeFocused()
      if (!await control.evaluate(element => !!element.closest('[data-pinned-actions]'))) await focusClear(control, true)
    }
    // Reverse the same natural DOM sequence, including sortable/filter headers.
    for (let index = await controls.count() - 2; index >= 0; index--) {
      await page.keyboard.press('Shift+Tab')
      const control = controls.nth(index)
      await expect(control).toBeFocused()
      if (!await control.evaluate(element => !!element.closest('[data-pinned-actions]'))) await focusClear(control, true)
    }
    observations.push({ kind: 'focus-traversal', width, language, compact, fontSize, offset, controls: await controls.count(), scrollLeft: await port.evaluate(element => element.scrollLeft) })
  }
  await controls.first().evaluate(element => { const box = element.getBoundingClientRect(); window.scrollBy(0, box.top + box.height / 2 - innerHeight / 2) })
  await page.screenshot({ path: `${process.env.LIST_V2_OUTPUT}/focus-${width}-${language}-${compact}-${fontSize}.png` })
})

for (const language of ['en', 'cs'] as const) test(`focus reveal: sorting, layout changes, restoration and pointer ${language}`, async ({ page, context, request }) => {
  const copy = language === 'cs' ? cs : en
  await page.setViewportSize({ width: 390, height: 844 })
  await context.addInitScript(language => localStorage.setItem('console-language', language), language)
  await page.goto(route); await settled(page)
  const port = list(page).locator('[data-slot="table-container"]')
  const codeHeader = port.getByRole('columnheader', { name: /Code/ })
  const code = codeHeader.getByRole('button').first()
  await code.focus(); await focusClear(code)
  const byCode = [...workers].sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0)
  await code.click(); await expect.poll(() => ids(page)).toEqual(byCode.slice(0, 10).map(row => row.id)); await focusClear(code)
  await page.keyboard.press('Enter'); await expect.poll(() => ids(page)).toEqual([...byCode].reverse().slice(0, 10).map(row => row.id)); await focusClear(code)
  await page.keyboard.press('Space'); await expect.poll(() => ids(page)).toEqual(workers.slice(0, 10).map(row => row.id)); await focusClear(code)
  // Active focus must be rechecked without another focus event on viewport change.
  await page.setViewportSize({ width: 360, height: 844 }); await focusClear(code)
  await page.setViewportSize({ width: 1440, height: 844 }); await focusClear(code)
  await page.setViewportSize({ width: 390, height: 844 }); await focusClear(code)
  await page.evaluate(() => { document.documentElement.style.fontSize = '32px' }); await focusClear(code)
  await page.evaluate(() => { document.documentElement.style.fontSize = '16px' }); await focusClear(code)
  // Resize the active control independently of the fixed-width column/table.
  await code.evaluate(element => { element.style.minWidth = '240px' })
  await focusClear(code)
  await code.evaluate(element => { element.style.minWidth = '' })
  await focusClear(code)
  await page.getByRole('button', { name: copy.listDisplay, exact: true }).click()
  const display = page.getByRole('dialog', { name: copy.listDisplayHeading })
  await display.getByRole('checkbox').nth(1).click()
  await page.keyboard.press('Escape')
  await code.focus(); await focusClear(code)
  const access = port.getByRole('button', { name: new RegExp(copy.rowAccessActions) }).first()
  await access.focus(); await focusClear(access)
  await access.press('Enter'); await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.press('Escape'); await focusClear(access)
  await access.press('Enter'); await page.getByRole('menuitem', { name: copy.rowFindMember, exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: copy.cancel, exact: true }).click()
  await focusClear(access)
  // The opaque Actions overlay keeps its own pointer targets at scrollLeft zero.
  await port.focus(); await page.keyboard.press('Home')
  await expect.poll(() => port.evaluate(element => element.scrollLeft)).toBe(0)
  const action = port.locator('tbody [data-pinned-actions] button').first()
  await action.click(); await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.press('Escape'); await expect(action).toBeFocused()
  const actionScroll = await port.evaluate(element => element.scrollLeft)
  await action.press('Enter'); await page.getByRole('menuitem', { name: copy.edit, exact: true }).click()
  const edit = page.getByRole('dialog')
  await expect(edit).toBeVisible()
  await edit.getByRole('button', { name: copy.cancel, exact: true }).click()
  await expect(action).toBeFocused()
  // Native restoration may scroll a sticky trigger into view; the reveal hook
  // must preserve its identity and leave it in the pinned pointer target.
  observations.push({ kind: 'pinned-restoration', before: actionScroll, after: await port.evaluate(element => element.scrollLeft) })
  expect(await action.evaluate(element => !!element.closest('[data-pinned-actions]'))).toBe(true)
  // A real save refreshes the list and restores the same Actions trigger.
  await action.click(); await page.getByRole('menuitem', { name: copy.edit, exact: true }).click()
  try {
    await edit.getByRole('textbox', { name: 'Code', exact: true }).fill('W1 focus refresh')
    await edit.getByRole('button', { name: copy.save, exact: true }).click()
    await expect(edit).toHaveCount(0); await settled(page); await expect(action).toBeFocused()
  } finally {
    // Keep the shared synthetic fixture identical for the remaining acceptance tests.
    const headers = { 'X-Organization-Id': 'org-a' }
    const current = await request.get('/api/worker/w001', { headers })
    const row = await current.json()
    if (row.code !== 'W1') expect((await request.patch('/api/worker/w001', { headers, data: { code: 'W1', version: row.version } })).ok()).toBe(true)
  }
  await code.focus(); await focusClear(code)
  const columnIndex = await codeHeader.evaluate(element => (element as HTMLTableCellElement).cellIndex)
  for (const cell of [codeHeader, ...await port.locator(`tbody tr[data-row-id] td:nth-child(${columnIndex + 1})`).all()]) {
    // Scroll vertically only, preserving the horizontal reveal being verified.
    await cell.evaluate(element => { const box = element.getBoundingClientRect(); window.scrollBy(0, box.top + box.height / 2 - innerHeight / 2) })
    expect(await cell.evaluate(element => { const box = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)) })).toBe(true)
  }
  for (const sticky of await port.locator('[data-pinned-actions]').all()) {
    expect(await sticky.evaluate(element => { const style = getComputedStyle(element); return { background: style.backgroundColor, position: style.position, z: style.zIndex } })).toMatchObject({ position: 'sticky', z: '10' })
    expect(await sticky.evaluate(element => getComputedStyle(element).backgroundColor)).toMatch(/^(rgb\(|color\(srgb [^/]+\)$|oklch\([^/]+\)$)/)
  }
  await port.focus(); await page.keyboard.press('End')
  await expect.poll(() => port.evaluate(element => element.scrollWidth - element.clientWidth - element.scrollLeft)).toBe(0)
  await expect(list(page).locator('[data-list-overflow]')).toHaveAttribute('data-list-overflow', 'start')
  await page.keyboard.press('Home')
  await expect.poll(() => port.evaluate(element => element.scrollLeft)).toBe(0)
  await expect(list(page).locator('[data-list-overflow]')).toHaveAttribute('data-list-overflow', 'end')
})

test('focus reveal: no Actions leaves native padding and keyboard scrolling unchanged', async ({ page, context }) => {
  await context.setExtraHTTPHeaders({ Authorization: 'Bearer list-v2-staff-session' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(route); await settled(page)
  const port = list(page).locator('[data-slot="table-container"]')
  await expect(port.locator('[data-pinned-actions]')).toHaveCount(0)
  expect(await port.evaluate(element => [element.style.scrollPaddingInlineStart, element.style.scrollPaddingInlineEnd])).toEqual(['', ''])
  await port.focus(); await page.keyboard.press('End')
  await expect(list(page).locator('[data-list-overflow]')).toHaveAttribute('data-list-overflow', 'start')
  await page.keyboard.press('Home')
  await expect.poll(() => port.evaluate(element => element.scrollLeft)).toBe(0)
})
async function settled(page: Page) {
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
  await expect(savedTrigger(page)).toHaveText(name)
}
const scenarios = ['populated-admin', 'populated-restricted-staff', 'expanded-filters', 'view-menu', 'access-menu', 'personal-views', 'empty', 'error', 'loading'] as const
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
    await page.goto(route)
    if (scenario === 'loading') { await expect(list(page).locator('[aria-busy="true"]')).toBeVisible(); await expect(footer(page).locator('[data-list-range]')).toHaveCount(0); await expect(list(page).locator('[data-list-slot="tabs"] span')).toHaveCount(0) }
    else if (scenario === 'error') { await expect(list(page).getByText(en.requestFailed, { exact: true }).first()).toBeVisible(); await expect(footer(page).locator('[data-list-range]')).toHaveCount(0); await expect(list(page).locator('[data-list-slot="tabs"] span')).toHaveCount(0) }
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
  await page.goto(route); await settled(page); await rows(page); await counts(page)
  await footer(page).getByRole('button', { name: en.nextPage, exact: true }).click(); await rows(page, {}, 10)
  await footer(page).getByRole('button', { name: en.previousPage, exact: true }).click(); await rows(page)
  await footer(page).getByRole('button', { name: '5', exact: true }).click(); await rows(page, {}, 40)
  await expect(footer(page).getByRole('button', { name: en.nextPage, exact: true })).toBeDisabled()
  await footer(page).getByRole('combobox', { name: en.rowsPerPage, exact: true }).selectOption('20'); await rows(page, {}, 0, 20)
})

test('G1: desktop configured access column fits beside separate Actions without scrolling or coverage', async ({ page }) => {
  await page.goto(route); await settled(page); await rows(page); await atScrollStart(page)
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
  await page.goto(route)
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
  await page.goto(route); await settled(page)
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
  await page.goto(route); await settled(page)
  for (const view of Object.keys(labels)) { await tab(page, view); await rows(page, { view }); await counts(page) }
  await tab(page, 'all'); await page.getByRole('searchbox', { name: en.search, exact: true }).fill('Worker 04')
  await rows(page, { search: 'Worker 04' }); await counts(page, { search: 'Worker 04' })
  await chooseTeam(page, 'North team'); await rows(page, { search: 'Worker 04', team: 'north' }); await counts(page, { search: 'Worker 04', team: 'north' })
  await page.getByRole('searchbox', { name: en.search, exact: true }).fill('no-such-seeded-worker'); await rows(page, { search: 'no-such-seeded-worker', team: 'north' }); await counts(page, { search: 'no-such-seeded-worker', team: 'north' })
  await context.setExtraHTTPHeaders({ Authorization: 'Bearer list-v2-staff-session' }); await page.goto(route); await settled(page)
  await rows(page, { actor: 'staff' }); await counts(page, { actor: 'staff' })
  await page.getByRole('searchbox', { name: en.search, exact: true }).fill('Worker 04'); await rows(page, { actor: 'staff', search: 'Worker 04' }); await counts(page, { actor: 'staff', search: 'Worker 04' })
  await chooseTeam(page, 'South team'); await rows(page, { actor: 'staff', search: 'Worker 04', team: 'south' }); await counts(page, { actor: 'staff', search: 'Worker 04', team: 'south' })
})

test('panel: staged rows/counts/URL, Cancel discard, Apply once and reset page', async ({ page }) => {
  const requests: unknown[] = []
  page.on('request', request => { if (new URL(request.url()).pathname === '/query') { const q = request.postDataJSON(); if (q.entity === 'worker' && q.includeTotal) requests.push(q) } })
  await page.goto(route); await settled(page); await footer(page).getByRole('button', { name: '3', exact: true }).click(); await rows(page, {}, 20)
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
  await page.goto(route); await settled(page); await tab(page, 'inactive'); await rows(page, { view: 'inactive' })
  await footer(page).getByRole('button', { name: '2', exact: true }).click(); await rows(page, { view: 'inactive' }, 10)
  await page.reload(); await settled(page); await rows(page, { view: 'inactive' }, 10)
})

test('URL: copied URL restores the current page as well as settings', async ({ page, context }) => {
  await page.goto(route); await settled(page); await tab(page, 'inactive'); await rows(page, { view: 'inactive' })
  await footer(page).getByRole('button', { name: '2', exact: true }).click(); await rows(page, { view: 'inactive' }, 10)
  const other = await context.newPage()
  try { await other.goto(page.url()); await settled(other); await rows(other, { view: 'inactive' }, 10) } finally { await other.close() }
})

test('URL: back and forward restore settings and history paging', async ({ page }) => {
  await page.goto(route); await settled(page); await tab(page, 'inactive'); await rows(page, { view: 'inactive' })
  await footer(page).getByRole('button', { name: '2', exact: true }).click(); await rows(page, { view: 'inactive' }, 10)
  await tab(page, 'active'); await rows(page, { view: 'active' }); await page.goBack(); await rows(page, { view: 'inactive' }, 10)
  await page.goForward(); await rows(page, { view: 'active' })
})

test('URL: invalid and forbidden parameters and relation IDs are sanitized', async ({ page, context }) => {
  await context.setExtraHTTPHeaders({ Authorization: 'Bearer list-v2-staff-session' })
  const filters = JSON.stringify([{ field: 'user', predicate: { eq: 'admin' } }, { field: 'team_id', predicate: { in: ['north'] } }])
  await page.goto(`${route}?view=invited&rowAccess=invited&sort=forbidden&page=-7&pageSize=13&filters=${encodeURIComponent(filters)}`)
  await settled(page); await rows(page, { actor: 'staff' }); await counts(page, { actor: 'staff' })
  await expect.poll(() => page.url()).not.toMatch(/north|invited|forbidden|pageSize=13/)
  await expect(page.getByText('North team', { exact: true })).toHaveCount(0)
})

test('personal views: save, apply, rename, delete and reload; settings only', async ({ page }) => {
  await page.goto(route); await settled(page); await tab(page, 'inactive'); await rows(page, { view: 'inactive' }); await save(page, 'My inactive')
  await page.reload(); await settled(page); await expect(savedTrigger(page)).toHaveText(en.savedViewsMenu)
  await tab(page, 'active'); await rows(page, { view: 'active' }); await savedTrigger(page).click()
  await savedMenu(page).getByRole('button', { name: 'My inactive', exact: true }).click(); await rows(page, { view: 'active' })
  await savedMenu(page).getByRole('button', { name: en.savedViewsApplyView, exact: true }).click(); await rows(page, { view: 'inactive' })
  await savedTrigger(page).click(); await savedMenu(page).getByRole('button', { name: en.savedViewsRenameThis, exact: true }).click()
  await page.getByRole('textbox', { name: en.savedViewsName, exact: true }).fill('Renamed inactive'); await page.getByRole('dialog').filter({ has: page.getByRole('textbox', { name: en.savedViewsName, exact: true }) }).getByRole('button', { name: en.savedViewsConfirm, exact: true }).click()
  const stored = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('workbase:saved-views:')).map(key => JSON.parse(localStorage.getItem(key)!)))
  record('observations', 'personal-views-storage', stored)
  expect(stored).toHaveLength(1)
  for (const entry of stored[0].entries) expect(Object.keys(entry.search).sort()).toEqual(['direction', 'sort', 'view'])
  await page.reload(); await settled(page); await savedTrigger(page).click(); await savedMenu(page).getByRole('button', { name: 'Renamed inactive', exact: true }).click(); await savedMenu(page).getByRole('button', { name: en.savedViewsApplyView, exact: true }).click(); await rows(page, { view: 'inactive' })
  await savedTrigger(page).click(); await savedMenu(page).getByRole('button', { name: en.savedViewsDeleteThis, exact: true }).click(); await page.getByRole('button', { name: en.savedViewsDelete, exact: true }).click()
  await page.reload(); await settled(page); await savedTrigger(page).click(); await expect(savedMenu(page).getByRole('button', { name: 'Renamed inactive', exact: true })).toHaveCount(0)
})

test('personal views: update current view through the naming dialog and reload', async ({ page }) => {
  await page.goto(route); await settled(page); await tab(page, 'inactive'); await rows(page, { view: 'inactive' }); await save(page, 'Update me')
  await tab(page, 'active'); await rows(page, { view: 'active' })
  await page.getByRole('button', { name: en.savedViewsSaveChanges, exact: true }).click()
  const naming = page.getByRole('dialog').filter({ has: page.getByRole('textbox', { name: en.savedViewsName, exact: true }) })
  await naming.getByRole('button', { name: en.savedViewsConfirm, exact: true }).click({ timeout: 5000 })
  await page.reload(); await settled(page); await tab(page, 'inactive'); await rows(page, { view: 'inactive' })
  await savedTrigger(page).click(); await savedMenu(page).getByRole('button', { name: 'Update me', exact: true }).click(); await savedMenu(page).getByRole('button', { name: en.savedViewsApplyView, exact: true }).click(); await rows(page, { view: 'active' })
})

test('personal views: rename then update in the same mounted session', async ({ page }) => {
  await page.goto(route); await settled(page); await tab(page, 'inactive'); await rows(page, { view: 'inactive' }); await save(page, 'Compound inactive')
  await page.reload(); await settled(page); await tab(page, 'active'); await rows(page, { view: 'active' })
  await savedTrigger(page).click(); await savedMenu(page).getByRole('button', { name: 'Compound inactive', exact: true }).click(); await savedMenu(page).getByRole('button', { name: en.savedViewsApplyView, exact: true }).click(); await rows(page, { view: 'inactive' })
  await savedTrigger(page).click(); await savedMenu(page).getByRole('button', { name: en.savedViewsRenameThis, exact: true }).click()
  await page.getByRole('textbox', { name: en.savedViewsName, exact: true }).fill('Compound renamed')
  const naming = () => page.getByRole('dialog').filter({ has: page.getByRole('textbox', { name: en.savedViewsName, exact: true }) })
  await naming().getByRole('button', { name: en.savedViewsConfirm, exact: true }).click()
  await tab(page, 'active'); await rows(page, { view: 'active' }); await page.getByRole('button', { name: en.savedViewsSaveChanges, exact: true }).click()
  // Preserve the original pointer-interaction oracle; never force past an overlay.
  await naming().getByRole('button', { name: en.savedViewsConfirm, exact: true }).click({ timeout: 5000 })
  await page.reload(); await settled(page); await tab(page, 'inactive'); await rows(page, { view: 'inactive' }); await savedTrigger(page).click(); await savedMenu(page).getByRole('button', { name: 'Compound renamed', exact: true }).click(); await savedMenu(page).getByRole('button', { name: en.savedViewsApplyView, exact: true }).click(); await rows(page, { view: 'active' })
})

test('same mounted tab: admin → staff → admin must replace rows, totals, counts and personal namespace', async ({ page, context }) => {
  test.setTimeout(120_000)
  await page.goto(route); await settled(page); await rows(page); await save(page, 'Admin private view')
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
  await page.goto(route); await settled(page)
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
  await context.setExtraHTTPHeaders({ Authorization: 'Bearer list-v2-staff-session' }); await page.goto(route); await settled(page); await rows(page, { actor: 'staff' })
  await expect(page.getByRole('columnheader', { name: en.rowAccess, exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: new RegExp(en.rowAccessActions) })).toHaveCount(0)
})

for (const width of [360, 390]) for (const language of ['en', 'cs'] as const) test(`paging: 200% text middle page ${width} ${language}`, async ({ page, context }) => {
  const copy = language === 'cs' ? cs : en
  await page.setViewportSize({ width, height: 1000 })
  await context.addInitScript(language => localStorage.setItem('console-language', language), language)
  await page.goto(`${route}?page=3`)
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
for (const width of [1110, 1231, 1233]) for (const language of ['en', 'cs'] as const) for (const number of [900, 1000]) test(`paging: 200% text boundary ${width} ${language} page ${number}`, async ({ page, context }) => {
  const copy = language === 'cs' ? cs : en
  await page.setViewportSize({ width, height: 1000 })
  await context.addInitScript(language => localStorage.setItem('console-language', language), language)
  await page.route('**/query', async intercepted => {
    const query = intercepted.request().postDataJSON()
    if (query.entity !== 'worker' || !query.includeTotal) return intercepted.continue()
    const response = await intercepted.fetch({ postData: JSON.stringify({ ...query, offset: 0 }) })
    await intercepted.fulfill({ response, json: { ...await response.json(), total: 10010 } })
  })
  await page.goto(`${route}?page=${number}`)
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
  const checkPaging = async (phase: string, controls = [previous, current, next]) => {
    for (const control of controls) {
      const geometry = await control.evaluate(element => {
        const box = element.getBoundingClientRect()
        const clips = [{ left: 0, right: innerWidth }]
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          if (/auto|scroll|hidden|clip/.test(getComputedStyle(parent).overflowX)) {
            const rect = parent.getBoundingClientRect()
            const style = getComputedStyle(parent)
            clips.push({ left: rect.left + parseFloat(style.borderLeftWidth), right: rect.right - parseFloat(style.borderRightWidth) })
          }
        }
        return { left: box.left, right: box.right, clipLeft: Math.max(...clips.map(clip => clip.left)), clipRight: Math.min(...clips.map(clip => clip.right)) }
      })
      observations.push({ kind: 'paging-boundary', phase, number, width, language, geometry })
      await expect(control).toBeVisible()
      expect.soft(geometry.left).toBeGreaterThanOrEqual(geometry.clipLeft)
      expect.soft(geometry.right).toBeLessThanOrEqual(geometry.clipRight)
    }
  }
  await checkPaging('before focus')
  await next.focus()
  await expect(next).toBeFocused()
  await checkPaging('after focusing Next')
  if (width === 1110 && number === 1000) {
    // Below the supported layout widths, retain native focus/scroll recovery
    // even when Previous/current/Next themselves cannot fit on one line.
    await page.setViewportSize({ width: 320, height: 1000 })
    await paging.scrollIntoViewIfNeeded()
    await previous.focus()
    const overflow = await paging.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }))
    expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth)
    await page.keyboard.press('Tab')
    await expect(current).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(next).toBeFocused()
    expect.soft(await paging.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
    await checkPaging('overflow fallback after focusing Next', [next])
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

for (const width of [1440, 390, 360]) for (const actor of ['admin', 'staff'] as const) for (const language of ['en', 'cs'] as const) test(`G4–G6 polish ${width} ${actor} ${language}`, async ({ page, context }) => {
  const copy = language === 'cs' ? cs : en
  await page.setViewportSize({ width, height: 1000 })
  await context.setExtraHTTPHeaders({ Authorization: `Bearer list-v2-${actor}-session` })
  await context.addInitScript(language => localStorage.setItem('console-language', language), language)
  await page.goto(route)
  await expect(list(page).locator('[data-list-range]')).toBeVisible()
  const table = list(page).locator('[data-slot="data-table"]')
  const row = table.locator('tbody [data-row-id]').first()
  await expect(table).toHaveAttribute('data-list-density', 'comfortable')
  expect(await row.locator('td').first().evaluate(element => getComputedStyle(element).fontSize)).toBe('11px')
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
  await expect(lookup).toHaveAttribute('placeholder', copy.listLookupPlaceholder)
  const paging = list(page).locator('[data-list-paging]')
  const prev = await paging.getByRole('button', { name: copy.previousPage, exact: true }).boundingBox()
  const next = await paging.getByRole('button', { name: copy.nextPage, exact: true }).boundingBox()
  expect(Math.abs(prev!.y - next!.y)).toBeLessThan(2)
  expect(prev!.x).toBeGreaterThanOrEqual(0)
  expect(next!.x + next!.width).toBeLessThanOrEqual(width)
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
    await page.goto(route)
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
