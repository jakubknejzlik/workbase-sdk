import { test, expect, type Page } from '@playwright/test'
import setup from './runtime/setup'
import { workers, expectedRows, expectedCounts, type Selection } from './runtime/list-v2-data'
import { capture, provenance, result, record } from './list-v2-evidence'
import en from '../src/locales/en.json' with { type: 'json' }

let observations: unknown[] = []
let stop: (() => Promise<void>) | undefined
const route = '/o/org-a/e/worker'
const labels: Record<string, string> = { all: 'All workers', active: 'Active workers', inactive: 'Inactive workers', empty: 'Archived workers', invited: 'Pending invitations' }
test.beforeAll(async ({ browser }) => { stop = await setup({ worker: 'list-v2-worker.ts', seed: 'list-v2-seed.ts' }); provenance(browser.version()) })
test.afterAll(async () => { await stop?.() })
test.beforeEach(async ({ context, page }) => { observations = []; page.on('response', response => { if (new URL(response.url()).pathname === '/query') void response.json().then(body => observations.push({ kind: 'query', request: response.request().postDataJSON(), status: response.status(), response: body })).catch(() => {}) }); await context.addInitScript(() => localStorage.setItem('console-language', 'en')) })
test.afterEach(async ({ page }, info) => { observations.push({ kind: 'final', url: page.url(), ids: await ids(page).catch(() => []), footer: await footer(page).textContent().catch(() => null), tabs: await page.getByRole('group', { name: en.listViews }).textContent().catch(() => null) }); record('functionalEvidence', info.title, observations); result(info) })
const list = (page: Page) => page.locator('[data-slot="list-page"]')
const footer = (page: Page) => list(page).locator('footer')
const panel = (page: Page) => page.getByRole('group', { name: en.sortAndFilter, exact: true })
const savedTrigger = (page: Page) => page.getByRole('region', { name: en.savedViews, exact: true }).locator('button[aria-haspopup="dialog"]')
const savedMenu = (page: Page) => page.getByRole('dialog', { name: en.savedViews, exact: true })
async function settled(page: Page) {
  await expect(list(page)).toBeVisible()
  await expect(list(page).getByText(en.loading, { exact: true })).toHaveCount(0)
  await expect(list(page).getByText(en.rowAccessRefreshing, { exact: true })).toHaveCount(0)
  await expect(footer(page).getByRole('status')).toBeVisible()
  await page.evaluate(async () => { await document.fonts.ready })
}
async function ids(page: Page) {
  return page.locator(`table a[href^="${route}/"]`).evaluateAll(links => links.map(link => decodeURIComponent(new URL((link as HTMLAnchorElement).href).pathname.split('/').at(-1)!)))
}
async function rows(page: Page, selection: Selection = {}, offset = 0, limit = 10) {
  const expected = expectedRows(selection)
  try { await expect.poll(() => ids(page), { message: `seed IDs ${JSON.stringify({ selection, offset, limit })}` }).toEqual(expected.slice(offset, offset + limit).map(row => row.id)) } finally { observations.push({ kind: 'rows', selection, offset, limit, expectedIds: expected.slice(offset, offset + limit).map(row => row.id), observedIds: await ids(page), expectedTotal: expected.length, observedRange: await footer(page).getByRole('status').textContent() }) }
  await expect(footer(page).getByRole('status')).toHaveText(en.listRangeTotal.replace('{{start}}', String(expected.length ? offset + 1 : 0)).replace('{{end}}', String(Math.min(offset + limit, expected.length))).replace('{{total}}', String(expected.length)))
}
async function counts(page: Page, selection: Selection = {}) {
  observations.push({ kind: 'counts', selection, expected: expectedCounts(selection), observed: await page.getByRole('group', { name: en.listViews }).textContent() })
  for (const [view, count] of Object.entries(expectedCounts(selection))) await expect(page.getByRole('group', { name: en.listViews }).getByRole('button', { name: new RegExp(`^${labels[view]}`) })).toHaveText(`${labels[view]}${count}`)
  if (selection.actor === 'staff') await expect(page.getByRole('button', { name: /^Pending invitations/ })).toHaveCount(0)
}
async function tab(page: Page, view: string) { await page.getByRole('group', { name: en.listViews }).getByRole('button', { name: new RegExp(`^${labels[view]}`) }).click() }
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
    if (scenario === 'loading') { await expect(list(page).locator('[aria-busy="true"]')).toBeVisible(); await expect(footer(page).getByRole('status')).toHaveCount(0); await expect(list(page).locator('[data-list-slot="tabs"] span')).toHaveCount(0) }
    else if (scenario === 'error') { await expect(list(page).getByText(en.requestFailed, { exact: true }).first()).toBeVisible(); await expect(footer(page).getByRole('status')).toHaveCount(0); await expect(list(page).locator('[data-list-slot="tabs"] span')).toHaveCount(0) }
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

test('URL: copied URL restores the current page as well as settings (#233 candidate)', async ({ page, context }) => {
  // Keep the strict acceptance expectation visible. Page lives in history.state on
  // this integration revision; independent s2 must decide the copied-page candidate.
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

test('personal views: save, apply, rename, update, delete and reload; settings only', async ({ page }) => {
  await page.goto(route); await settled(page); await tab(page, 'inactive'); await rows(page, { view: 'inactive' }); await save(page, 'My inactive')
  await page.reload(); await settled(page); await expect(savedTrigger(page)).toHaveText(en.savedViewsMenu)
  await tab(page, 'active'); await rows(page, { view: 'active' }); await savedTrigger(page).click()
  await savedMenu(page).getByRole('button', { name: 'My inactive', exact: true }).click(); await rows(page, { view: 'active' })
  await savedMenu(page).getByRole('button', { name: en.savedViewsApplyView, exact: true }).click(); await rows(page, { view: 'inactive' })
  await savedTrigger(page).click(); await savedMenu(page).getByRole('button', { name: en.savedViewsRenameThis, exact: true }).click()
  await page.getByRole('textbox', { name: en.savedViewsName, exact: true }).fill('Renamed inactive'); await page.getByRole('dialog').filter({ has: page.getByRole('textbox', { name: en.savedViewsName, exact: true }) }).getByRole('button', { name: en.savedViewsConfirm, exact: true }).click()
  await tab(page, 'active'); await rows(page, { view: 'active' }); await page.getByRole('button', { name: en.savedViewsSaveChanges, exact: true }).click(); await page.getByRole('dialog').filter({ has: page.getByRole('textbox', { name: en.savedViewsName, exact: true }) }).getByRole('button', { name: en.savedViewsConfirm, exact: true }).click()
  const stored = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('workbase:saved-views:')).map(key => JSON.parse(localStorage.getItem(key)!)))
  record('observations', 'personal-views-storage', stored)
  expect(stored).toHaveLength(1)
  for (const entry of stored[0].entries) expect(Object.keys(entry.search).sort()).toEqual(['direction', 'sort', 'view'])
  await page.reload(); await settled(page); await savedTrigger(page).click(); await savedMenu(page).getByRole('button', { name: 'Renamed inactive', exact: true }).click(); await savedMenu(page).getByRole('button', { name: en.savedViewsApplyView, exact: true }).click(); await rows(page, { view: 'active' })
  await savedTrigger(page).click(); await savedMenu(page).getByRole('button', { name: en.savedViewsDeleteThis, exact: true }).click(); await page.getByRole('button', { name: en.savedViewsDelete, exact: true }).click()
  await page.reload(); await settled(page); await savedTrigger(page).click(); await expect(savedMenu(page).getByRole('button', { name: 'Renamed inactive', exact: true })).toHaveCount(0)
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
      observations.push({ kind: 'actor', actor, expectedIds: expected.slice(0, 10).map(row => row.id), observedIds: actualIds, expectedTotal: expected.length, observedRange: await footer(page).getByRole('status').textContent(), expectedCounts: expectedCounts({ actor }), observedTabs: await page.getByRole('group', { name: en.listViews }).textContent() })
      await expect.soft(footer(page).getByRole('status')).toHaveText(en.listRangeTotal.replace('{{start}}', '1').replace('{{end}}', '10').replace('{{total}}', String(expected.length)))
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
