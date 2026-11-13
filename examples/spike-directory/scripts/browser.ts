import { chromium } from 'playwright'
import { preview } from 'vite'
import { mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '..')
// Review artifacts deliberately live outside the public Git tree.
const artifacts = resolve(root, '../../../round2-artifacts')
await mkdir(artifacts, { recursive: true })
const server = await preview({ root, configFile: false, preview: { host: '127.0.0.1', port: 4178, strictPort: true } })
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  for (const [path, mode] of [['/workers', 'list'], ['/workers/w1', 'detail'], ['/workers/new', 'create'], ['/workers/w1/edit', 'edit'], ['/workers/w1/trasa', 'customPage'], ['/jobs', 'list'], ['/jobs/j1', 'detail'], ['/jobs/new', 'create'], ['/jobs/j1/edit', 'edit'], ['/overview', 'list']]) {
    await page.goto(`http://127.0.0.1:4178${path}`)
    await page.locator(`[data-page="${mode}"]`).waitFor()
    if (mode === 'customPage') assert.equal(await page.locator('.leaflet-container .leaflet-interactive').count(), 2)
    console.log(`P1 render PASS ${path} (${mode})`)
  }
  for (const [entity, id] of [['workers', 'w1'], ['jobs', 'j1']]) {
    await page.goto(`http://127.0.0.1:4178/${entity}`)
    await page.locator('tbody tr').first().waitFor()
    await page.screenshot({ path: resolve(artifacts, `${entity}-list.png`), fullPage: true })
    await page.goto(`http://127.0.0.1:4178/${entity}/${id}`)
    if (entity === 'workers') {
      await page.getByTestId('access-slot').waitFor()
      await page.getByRole('tab', { name: 'Notes', exact: true }).click()
      assert.ok(await page.getByText('No notes in this worker slice.').isVisible())
      await page.getByRole('tab', { name: 'Assigned shifts', exact: true }).click()
    }
    const columns = page.locator('[data-kind="columns"] > .cell')
    for (const width of [1440, 1100, 900]) {
      await page.setViewportSize({ width, height: 1000 })
      const left = await columns.nth(0).boundingBox()
      const right = await columns.nth(1).boundingBox()
      assert.ok(left && right && right.x > left.x && left.width > right.width)
      assert.ok(Math.abs(left.width / right.width - 2) < 0.25)
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.screenshot({ path: resolve(artifacts, `${entity}-detail.png`), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    const left = await columns.nth(0).boundingBox()
    const right = await columns.nth(1).boundingBox()
    assert.ok(left && right && right.y > left.y)
    await page.screenshot({ path: resolve(artifacts, `${entity}-detail-mobile.png`), fullPage: true })
    await page.setViewportSize({ width: 1440, height: 1000 })
    console.log(`P6 PASS ${entity}: list/detail screenshots; md/lg/xl 8/4 columns; mobile stacks`)
  }
  for (const [path, count, excluded] of [['/workers/w1', 2, 'Sam Taylor'], ['/workers/w2', 1, 'Alex Morgan'], ['/jobs/j1', 1, 'Sam Taylor'], ['/jobs/j2', 2, 'Office visit']] as const) {
    await page.goto(`http://127.0.0.1:4178${path}`)
    const relation = page.locator('[data-relation="slots"]')
    await relation.waitFor()
    assert.equal(await relation.locator('tbody tr').count(), count)
    assert.ok(!(await relation.innerText()).includes(excluded))
  }
  console.log('3 PASS schema-driven related tables filter both foreign keys for both records')
  await page.goto('http://127.0.0.1:4178/workers/w1/edit')
  await page.getByLabel('Name', { exact: true }).fill('Alex Edited')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('heading', { name: 'Alex Edited', exact: true }).waitFor()
  await page.getByRole('link', { name: 'New worker', exact: true }).click()
  await page.getByLabel('Name', { exact: true }).fill('New test worker')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('heading', { name: 'New test worker', exact: true }).waitFor()
  console.log('P1 PASS worker in-memory edit/create and redirect')
  await page.getByRole('navigation').getByRole('link', { name: 'Jobs', exact: true }).click()
  await page.getByRole('link', { name: 'Office visit', exact: true }).click()
  await page.getByRole('link', { name: 'Edit job', exact: true }).click()
  await page.getByLabel('Title', { exact: true }).fill('Office edited')
  await page.getByLabel('Client', { exact: true }).selectOption('c2')
  await page.getByLabel('Priority', { exact: true }).selectOption('high')
  assert.ok(await page.getByLabel('Status', { exact: true }).isDisabled())
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('heading', { name: 'Office edited', exact: true }).waitFor()
  assert.ok(await page.locator('.field strong').filter({ hasText: 'Example Studio' }).isVisible())
  assert.ok(await page.locator('.field strong').filter({ hasText: 'High' }).isVisible())
  await page.getByRole('link', { name: 'New job', exact: true }).click()
  await page.getByLabel('Title', { exact: true }).fill('New test job')
  await page.getByLabel('Client', { exact: true }).selectOption('c1')
  await page.getByLabel('Priority', { exact: true }).selectOption('low')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('heading', { name: 'New test job', exact: true }).waitFor()
  assert.ok(await page.locator('.field strong').filter({ hasText: 'Draft' }).isVisible())
  await page.getByRole('navigation').getByRole('link', { name: 'Jobs', exact: true }).click()
  assert.ok(await page.getByRole('link', { name: 'New test job', exact: true }).isVisible())
  console.log('2 PASS job string/ref/enum create/edit persisted independently; readOnly status preserved; list updated')
  assert.deepEqual(errors, [])
  await writeFile(resolve(artifacts, 'browser.json'), JSON.stringify({ browser: await browser.version(), errors, routes: 10 }, null, 2) + '\n')
  console.log(`Screenshots: ${artifacts}/{workers,jobs}-{list,detail,detail-mobile}.png`)
} finally { await browser.close(); await new Promise<void>(done => server.httpServer.close(() => done())) }
