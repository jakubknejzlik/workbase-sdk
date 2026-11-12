import { chromium } from 'playwright'
import { preview } from 'vite'
import { mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '..')
const server = await preview({ root, configFile: false, preview: { host: '127.0.0.1', port: 4178, strictPort: true } })
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  for (const [path, mode] of [['/workers', 'list'], ['/workers/w1', 'detail'], ['/workers/new', 'create'], ['/workers/w1/edit', 'edit'], ['/workers/w1/trasa', 'trasa']]) {
    await page.goto(`http://127.0.0.1:4178${path}`)
    await page.locator(`[data-page="${mode}"]`).waitFor()
    if (mode === 'trasa') assert.equal(await page.locator('.leaflet-container .leaflet-interactive').count(), 2)
    console.log(`P1 render PASS ${path} (${mode})`)
  }
  await page.goto('http://127.0.0.1:4178/workers/w1')
  await page.getByTestId('access-slot').waitFor()
  const columns = page.locator('[data-kind="columns"] > .cell')
  const left = await columns.nth(0).boundingBox()
  const right = await columns.nth(1).boundingBox()
  assert.ok(left && right && right.x > left.x && left.width > right.width)
  await page.getByRole('tab', { name: 'Notes', exact: true }).click()
  assert.ok(await page.getByText('No notes in this worker slice.').isVisible())
  await page.getByRole('tab', { name: 'Assigned shifts', exact: true }).click()
  await mkdir(resolve(root, 'artifacts'), { recursive: true })
  await page.screenshot({ path: resolve(root, 'artifacts/detail-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  const mobileLeft = await columns.nth(0).boundingBox()
  const mobileRight = await columns.nth(1).boundingBox()
  assert.ok(mobileLeft && mobileRight && mobileRight.y > mobileLeft.y)
  await page.screenshot({ path: resolve(root, 'artifacts/detail-mobile.png'), fullPage: true })
  console.log('P6 PASS desktop columns + interactive tabs + access slot; mobile columns stack; screenshots saved')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('http://127.0.0.1:4178/workers/w1/edit')
  await page.getByLabel('Name', { exact: true }).fill('Anna Edited')
  await page.getByRole('button', { name: 'Save worker' }).click()
  await page.getByRole('heading', { name: 'Anna Edited', exact: true }).waitFor()
  await page.getByRole('link', { name: 'New worker', exact: true }).click()
  await page.getByLabel('Name', { exact: true }).fill('New test worker')
  await page.getByRole('button', { name: 'Save worker' }).click()
  await page.getByRole('heading', { name: 'New test worker', exact: true }).waitFor()
  console.log('P1 PASS in-memory edit and create save/redirect')
  assert.deepEqual(errors, [])
  await writeFile(resolve(root, 'artifacts/browser.json'), JSON.stringify({ browser: await browser.version(), errors, routes: 5, screenshots: ['detail-desktop.png', 'detail-mobile.png'] }, null, 2) + '\n')
} finally { await browser.close(); await new Promise<void>(done => server.httpServer.close(() => done())) }
