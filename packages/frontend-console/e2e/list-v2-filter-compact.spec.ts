import { test, expect, type Page, type Locator } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import setup from './runtime/setup'
import { gotoSDK } from './list-v2-readiness'
import { workers } from './runtime/list-v2-data'
import en from '../src/locales/en.json' with { type: 'json' }
import cs from '../src/locales/cs.json' with { type: 'json' }

const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const build = JSON.parse(readFileSync(new URL('../dist/build-meta.json', import.meta.url), 'utf8'))
const root = process.env.A3C_OUTPUT!
if (!root) throw new Error('A3C_OUTPUT is required for verified compact-filter evidence')
const output = join(root, 'captures', head)
let stop: (() => Promise<void>) | undefined
const captures: unknown[] = [], queries: unknown[] = [], dateMeasurements: unknown[] = []
test.beforeAll(async () => { expect(build.sourceCommit).toBe(head); mkdirSync(output, { recursive: true }); stop = await setup({ worker: 'list-v2-worker.ts', seed: 'list-v2-seed.ts' }) })
test.afterAll(async () => {
  await stop?.()
  writeFileSync(join(output, 'manifest.json'), JSON.stringify({ head, build, baselineManifest: process.env.A3C_BEFORE_MANIFEST ?? null, captures, queries, dateMeasurements }, null, 2) + '\n')
})
const toolbar = (page: Page) => page.locator('[data-list-slot="toolbar"]')
const panel = (page: Page, language: 'en' | 'cs') => page.getByRole('group', { name: (language === 'cs' ? cs : en).sortAndFilter, exact: true })
async function start(page: Page, language: 'en' | 'cs', width: number, text = 100) {
  await page.setViewportSize({ width, height: 1000 })
  await page.addInitScript(locale => localStorage.setItem('console-language', locale), language)
  const response = await page.request.get('/o/org-a/console-model')
  expect(response.ok()).toBe(true)
  const metadata = await response.json()
  const labels = metadata.model.enumLabels[language]
  for (const field of ['status', 'approved', 'created_at']) expect(labels[`field_${field}_worker`].length).toBeGreaterThan(60)
  expect(metadata.model.entities.worker.list.filter.status.label).toBeUndefined()
  expect(metadata.model.entities.worker.list.filter.approved.label).toBeUndefined()
  expect(metadata.model.entities.worker.list.columns.find((column: any) => column.field === 'created_at').defaultVisible).toBe(false)
  await gotoSDK(page, '/o/org-a/e/worker')
  await expect(page.locator('[data-list-range]')).toBeVisible()
  await page.evaluate(async text => { document.documentElement.style.fontSize = `${16 * text / 100}px`; await document.fonts.ready }, text)
  return labels as Record<string, string>
}
async function geometry(page: Page, controls: Locator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  const bounds = await controls.evaluateAll(elements => elements.map(element => {
    const box = element.getBoundingClientRect(), css = getComputedStyle(element)
    const text = element.querySelector('.truncate') ?? element
    const textCSS = getComputedStyle(text)
    return { name: element.getAttribute('aria-label') ?? element.textContent, x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height,
      fits: element.scrollWidth <= element.clientWidth + 1 || textCSS.textOverflow === 'ellipsis' && !!element.getAttribute('aria-label'), wrap: css.whiteSpace }
  }).filter(box => box.width && box.height))
  for (const [index, box] of bounds.entries()) {
    expect(box.x, box.name ?? '').toBeGreaterThanOrEqual(0)
    expect(box.right, box.name ?? '').toBeLessThanOrEqual(page.viewportSize()!.width)
    expect(box.fits, `unclipped text or accessible ellipsis: ${box.name}`).toBe(true)
    for (const other of bounds.slice(index + 1)) expect(box.right <= other.x + 1 || other.right <= box.x + 1 || box.bottom <= other.y + 1 || other.bottom <= box.y + 1, `neighbours: ${box.name} / ${other.name}`).toBe(true)
  }
  return bounds
}
async function capture(page: Page, language: 'en' | 'cs', state: string, text = 100) {
  await page.evaluate(async () => { await document.fonts.ready; await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))) })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  const file = join(output, `${language}-${page.viewportSize()!.width}-${text}-${state}.png`)
  const heights = { toolbar: await toolbar(page).evaluate(element => element.getBoundingClientRect().height), panel: await panel(page, language).count() ? await page.locator('[data-list-slot="panel"]').evaluate(element => element.getBoundingClientRect().height) : null }
  let before: unknown = null
  if (process.env.A3C_BEFORE_MANIFEST) {
    const entries = JSON.parse(readFileSync(process.env.A3C_BEFORE_MANIFEST, 'utf8')).A3a
    const prefix = `A3a-${language}-${page.viewportSize()!.width}-`
    const selected = entries[`${prefix}filter-team_id-top.png`], closed = entries[`${prefix}closed-top.png`], expanded = entries[`${prefix}filters-content.png`]
    before = { toolbarSelected: selected?.metrics.toolbar.height ?? null, toolbarClosed: closed?.metrics.toolbar.height ?? null,
      panel: expanded && closed ? expanded.metrics.list.height - closed.metrics.list.height : null, panelMethod: 'A3a manifest expanded list height minus closed list height' }
  }
  await page.screenshot({ path: file, fullPage: state.includes('panel') || state.includes('calendar'), animations: 'disabled' })
  const bytes = readFileSync(file), hash = createHash('sha256').update(bytes).digest('hex')
  expect(statSync(file).size).toBeGreaterThan(1000)
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  const decoded = await page.evaluate(async base64 => { const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode(); return { width: image.naturalWidth, height: image.naturalHeight } }, bytes.toString('base64'))
  expect(decoded.width).toBe(page.viewportSize()!.width)
  expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(hash)
  captures.push({ file, width: page.viewportSize()!.width, locale: language, state, text, head, sourceSHA: head, builtAssetSHA: build.sha, sha256: hash, bytes: bytes.length, decoded, before, measuredHeights: heights })
}
for (const [language, width] of [['cs', 1440], ['cs', 900], ['cs', 390], ['en', 1440]] as const) test(`compact controls ${language} ${width}`, async ({ page }) => {
  const copy = language === 'cs' ? cs : en
  await start(page, language, width)
  const relationTrigger = page.getByRole('combobox', { name: 'Team', exact: true })
  const originalHeight = (await relationTrigger.boundingBox())!.height
  expect(originalHeight).toBe((await toolbar(page).getByRole('button', { name: copy.sortAndFilter, exact: true }).boundingBox())!.height)
  await capture(page, language, 'relation-closed')
  await page.getByRole('combobox', { name: 'Team', exact: true }).click()
  const relation = page.getByRole('dialog', { name: 'Team', exact: true })
  const searchResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/query' && response.request().postDataJSON()?.entity === 'team' && JSON.stringify(response.request().postDataJSON()?.where ?? {}).includes('North'))
  await relation.getByRole('searchbox').fill('North')
  expect((await searchResponse).ok()).toBe(true)
  await expect(relation.getByRole('option', { name: 'North team', exact: true })).toBeVisible()
  await expect(relation.getByRole('option', { name: 'South team', exact: true })).toHaveCount(0)
  await capture(page, language, 'relation-search-results')
  await relation.getByRole('option', { name: 'North team', exact: true }).click()
  await expect(relation).toBeHidden()
  await relationTrigger.click()
  await expect(relation.getByRole('option', { name: 'North team', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('group', { name: copy.activeFilters, exact: true })).toContainText('North team')
  expect((await relationTrigger.boundingBox())!.height).toBe(originalHeight)
  await expect(toolbar(page).getByRole('option')).toHaveCount(0)
  await capture(page, language, 'relation-selected-chip')
  await page.getByRole('button', { name: copy.clearAllFilters, exact: true }).click()
  await page.getByRole('button', { name: copy.sortAndFilter, exact: true }).click()
  const number = panel(page, language).getByRole('group', { name: 'Amount', exact: true })
  const date = panel(page, language).getByRole('group', { name: 'Due date', exact: true })
  await number.getByRole('combobox', { name: copy.filterOperator }).selectOption('equals')
  await number.getByLabel(copy.filterSingle, { exact: true }).fill('200')
  await capture(page, language, 'panel-number-equals')
  await number.getByRole('combobox', { name: copy.filterOperator }).selectOption('between')
  await number.getByLabel(copy.filterFrom, { exact: true }).fill('200'); await number.getByLabel(copy.filterTo, { exact: true }).fill('300')
  await capture(page, language, 'panel-number-between')
  for (const operator of ['equals', 'between']) {
    await date.getByRole('combobox', { name: copy.filterOperator }).selectOption(operator)
    const label = operator === 'equals' ? copy.filterSingle : copy.filterFrom
    await date.getByLabel(label, { exact: true }).fill('2026-02-10')
    const legibility = async (state: string) => {
      const bounds = date.locator('input')
      await expect(bounds).toHaveCount(2)
      const measurements = await bounds.evaluateAll(inputs => inputs.map(input => ({
        value: (input as HTMLInputElement).value, clientWidth: input.clientWidth, scrollWidth: input.scrollWidth,
      })))
      for (const [bound, measurement] of measurements.entries()) {
        dateMeasurements.push({ locale: language, width, state, bound, ...measurement })
        expect(measurement.value).toBe('2026-02-10')
        expect.soft(measurement.scrollWidth, `${language} ${width} ${state} bound ${bound}: full date legible`).toBeLessThanOrEqual(measurement.clientWidth)
      }
    }
    if (operator === 'between') {
      await date.getByLabel(copy.filterTo, { exact: true }).fill('2026-02-10')
      await date.locator('input').evaluateAll(inputs => inputs.forEach(input => (input as HTMLInputElement).blur()))
      await legibility('calendar-closed')
      await capture(page, language, 'date-between-values-closed')
    }
    await date.getByRole('button', { name: `${copy.selectDateRange}: ${label}`, exact: true }).click()
    await expect(page.getByRole('grid')).toBeVisible()
    if (operator === 'between') {
      await legibility('calendar-open')
      await capture(page, language, 'date-between-values-calendar')
    }
    await capture(page, language, `panel-date-${operator}-calendar`)
    await page.keyboard.press('Escape')
  }
  await geometry(page, toolbar(page).locator('input, button'))
})
for (const language of ['en', 'cs'] as const) for (const width of [1440, 390]) test(`served long labels ${language} ${width} at 200 percent text`, async ({ page }) => {
  const copy = language === 'cs' ? cs : en
  const dictionary = await start(page, language, width, 200)
  const status = dictionary.field_status_worker, approved = dictionary.field_approved_worker, created = dictionary.field_created_at_worker
  const trigger = toolbar(page).getByRole('button', { name: status, exact: true })
  await expect(trigger).toBeVisible(); await expect(trigger).toHaveAccessibleName(status)
  await geometry(page, toolbar(page).locator('input, button'))
  await capture(page, language, 'long-toolbar', 200)
  await trigger.click()
  await page.getByRole('dialog', { name: status, exact: true }).getByRole('checkbox', { name: 'active', exact: true }).click()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: copy.sortAndFilter, exact: true }).click()
  const group = panel(page, language).getByRole('group', { name: approved, exact: true })
  await expect(group).toHaveAccessibleName(approved)
  expect(await group.locator('legend').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await geometry(page, panel(page, language).locator('input, select, button'))
  const captions = await panel(page, language).locator('fieldset').evaluateAll(fields => fields.flatMap(field => {
    const box = field.getBoundingClientRect()
    return Array.from(field.querySelectorAll('legend, p')).flatMap(caption => {
      const range = document.createRange(); range.selectNodeContents(caption)
      return Array.from(range.getClientRects()).map(rect => ({ text: caption.textContent, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, field: { left: box.left, right: box.right, top: box.top, bottom: box.bottom } }))
    })
  }))
  for (const caption of captions) {
    expect(caption.left, caption.text ?? '').toBeGreaterThanOrEqual(caption.field.left - 1)
    expect(caption.right, caption.text ?? '').toBeLessThanOrEqual(caption.field.right + 1)
  }
  await capture(page, language, 'long-panel', 200)
  await group.getByRole('combobox').click(); await page.getByRole('option', { name: copy.yes, exact: true }).click()
  await panel(page, language).getByRole('button', { name: copy.applyFilter, exact: true }).click()
  const chips = page.getByRole('group', { name: copy.activeFilters, exact: true })
  for (const label of [status, approved]) {
    await expect(chips).toContainText(label)
    await expect(chips.getByRole('button', { name: new RegExp(label) })).toHaveCount(1)
  }
  expect(await chips.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  for (const span of await chips.locator('[data-slot="badge"] > span').all()) expect(await span.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await geometry(page, chips.locator('button'))
  await capture(page, language, 'long-chips', 200)
  await page.getByRole('button', { name: copy.listDisplay, exact: true }).click()
  const columns = page.getByRole('dialog', { name: copy.listDisplayHeading, exact: true })
  await expect(columns.getByRole('checkbox', { name: created, exact: true })).toBeVisible()
  await columns.getByRole('checkbox', { name: created, exact: true }).scrollIntoViewIfNeeded()
  // A3b owns hard Columns geometry assertions; capture its served long label here.
  await capture(page, language, 'long-columns', 200)
})
test('all compact operators keep real server predicates and Apply/Cancel behavior', async ({ page }) => {
  await start(page, 'en', 1440)
  const requests: any[] = []
  page.on('request', request => { if (new URL(request.url()).pathname === '/query' && request.postDataJSON()?.entity === 'worker' && request.postDataJSON()?.includeTotal) requests.push(request.postDataJSON()) })
  for (const field of ['amount', 'due_on']) for (const operator of ['equals', 'from', 'to', 'between']) {
    await page.getByRole('button', { name: en.sortAndFilter, exact: true }).click()
    const group = panel(page, 'en').getByRole('group', { name: field === 'amount' ? 'Amount' : 'Due date', exact: true })
    const before = requests.length
    await group.getByRole('combobox', { name: en.filterOperator }).selectOption(operator)
    const from = field === 'amount' ? '200' : '2026-02-10', to = field === 'amount' ? '300' : '2026-02-15'
    await group.getByLabel(operator === 'equals' ? en.filterSingle : operator === 'to' ? en.filterTo : en.filterFrom, { exact: true }).fill(operator === 'to' ? to : from)
    if (operator === 'between') await group.getByLabel(en.filterTo, { exact: true }).fill(to)
    expect(requests.length, 'operator and values remain drafts').toBe(before)
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/query' && response.request().postDataJSON()?.entity === 'worker' && response.request().postDataJSON()?.includeTotal)
    await panel(page, 'en').getByRole('button', { name: en.applyFilter, exact: true }).click()
    const applied = await response, body = await applied.json(), query = applied.request().postDataJSON()
    expect(applied.ok()).toBe(true)
    const expected = workers.filter(row => { const value = field === 'amount' ? row.amount : row.due_on.slice(0, 10); const a = field === 'amount' ? Number(from) : from, b = field === 'amount' ? Number(to) : to; return operator === 'equals' ? value === a : operator === 'from' ? value >= a : operator === 'to' ? value <= b : value >= a && value <= b })
    expect(body.data.map((row: any) => row.id)).toEqual(expected.slice(0, 10).map(row => row.id))
    expect(body.total).toBe(expected.length)
    const predicate = field === 'amount' ? operator === 'equals' ? { eq: 200 } : operator === 'from' ? { gte: 200 } : operator === 'to' ? { lte: 300 } : { gte: 200, lte: 300 } : operator === 'equals' ? { gte: '2026-02-10T00:00:00.000Z', lt: '2026-02-11T00:00:00.000Z' } : operator === 'from' ? { gte: '2026-02-10T00:00:00.000Z' } : operator === 'to' ? { lt: '2026-02-16T00:00:00.000Z' } : { gte: '2026-02-10T00:00:00.000Z', lt: '2026-02-16T00:00:00.000Z' }
    expect(query.where).toEqual({ and: [{ [field]: predicate }] })
    queries.push({ field, operator, query, ids: body.data.map((row: any) => row.id), total: body.total })
    await page.getByRole('button', { name: en.sortAndFilter, exact: true }).click()
    await panel(page, 'en').getByRole('group', { name: field === 'amount' ? 'Amount' : 'Due date', exact: true }).getByRole('combobox', { name: en.filterOperator }).selectOption('between')
    const cancelBefore = requests.length
    await panel(page, 'en').getByRole('button', { name: en.cancel, exact: true }).click()
    expect(requests.length).toBe(cancelBefore)
    await page.getByRole('button', { name: en.clearAllFilters, exact: true }).click()
    await expect(page.locator('[data-list-range]')).toHaveText(en.listRangeTotal.replace('{{start}}', '1').replace('{{end}}', '10').replace('{{total}}', '47'))
  }
})
