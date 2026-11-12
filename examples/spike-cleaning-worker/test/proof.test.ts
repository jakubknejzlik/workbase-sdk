import { afterEach, expect, test } from 'vitest'
import { cp, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { extractManifest } from '@workbasehq/ui-v3/vite'
import { customPage, getManifest, slotInput, defineSlot } from '@workbasehq/ui-v3'
import schema from '../schema'
const root = resolve(import.meta.dirname, '..')
const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
async function fixture() {
  const dir = await mkdtemp(resolve(root, '.proof-'))
  temporary.push(dir)
  for (const file of ['ui', 'schema.ts']) await cp(resolve(root, file), resolve(dir, file), { recursive: true })
  return dir
}
function ci(dir: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', resolve(root, 'scripts/check.ts'), dir], { cwd: root, encoding: 'utf8' })
}
function rejected(result: ReturnType<typeof ci>, message: RegExp) {
  const output = result.stdout + result.stderr
  expect(result.status, output).not.toBe(0)
  expect(output).toMatch(message)
  console.log(output.trim())
}
test('P2/P5: Node extraction returns all five routes, layouts and dependencies without Leaflet execution', async () => {
  expect(typeof window).toBe('undefined')
  const raw = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('leaflet')"], { cwd: root, encoding: 'utf8' })
  rejected(raw, /window is not defined/)
  const result = await extractManifest(root)
  expect(result.routes.map(route => route.path).sort()).toEqual(['/workers', '/workers/$id', '/workers/$id/edit', '/workers/$id/trasa', '/workers/new'])
  expect(result.stubbed).toContain('ui/workers/-components/TrasaView.tsx')
  expect(result.routes.find(route => route.mode === 'detail')?.uses).toEqual(['slot.booked', 'slot.job_id', 'slot.starts_at', 'worker.name', 'worker.user'])
  expect(result.routes.find(route => route.mode === 'detail')?.layout?.nodes[1]).toMatchObject({ kind: 'columns' })
  expect(result.routes.find(route => route.kind === 'customPage')).toMatchObject({ layout: null, editable: false, title: 'workers.trasa.title' })
  console.log(`P2/P5: ${result.routes.length} routes; extraction ${result.extractionMs} ms; stubbed ${result.stubbed.join(', ')}`)
})
test('P3: nmae in nested layout fails the real TypeScript CLI', async () => {
  const dir = await fixture()
  const file = resolve(dir, 'negative.ts')
  await writeFile(file, "import { layout, row } from '../ui/-model'; layout([row([['nmae', 12]])]);\n")
  const result = spawnSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--ignoreConfig', '--strict', '--skipLibCheck', '--target', 'ES2023', '--module', 'esnext', '--moduleResolution', 'bundler', '--jsx', 'react-jsx', '--esModuleInterop', file], { cwd: root, encoding: 'utf8' })
  rejected(result, /nmae.*not assignable/)
})
test('P3: removed field in custom uses fails the CI command', async () => {
  const dir = await fixture()
  for (const path of ['ui/workers/index.ts', 'ui/workers/new.ts', 'ui/workers/$id/index.ts', 'ui/workers/$id/edit.ts']) await rm(resolve(dir, path))
  await writeFile(resolve(dir, 'ui/nav.ts'), 'export default []\n')
  const file = resolve(dir, 'schema.ts')
  await writeFile(file, (await readFile(file, 'utf8')).replace("name: { type: 'string' }, ", ''))
  rejected(ci(dir), /Unknown uses field worker.name/)
})
test('P4: TSX route outside a minus directory fails the CI command', async () => {
  const dir = await fixture()
  await writeFile(resolve(dir, 'ui/workers/bad.tsx'), 'export default () => null\n')
  rejected(ci(dir), /\.tsx must be inside a -prefixed directory/)
})
test('P4: React import in a data page fails the CI command', async () => {
  const dir = await fixture()
  const file = resolve(dir, 'ui/workers/index.ts')
  await writeFile(file, "import React from 'react';\n" + await readFile(file, 'utf8'))
  rejected(ci(dir), /data page must not import React/)
})
test('CI: React re-export through a data layout fails', async () => {
  const dir = await fixture()
  const file = resolve(dir, 'ui/workers/-list.ts')
  await writeFile(file, "export { useState } from 'react';\n" + await readFile(file, 'utf8'))
  rejected(ci(dir), /data page must not import React/)
})
test('CI: customPage data import fails', async () => {
  const dir = await fixture()
  const file = resolve(dir, 'ui/workers/$id/trasa.ts')
  await writeFile(file, "import schema from '../../../schema';\n" + await readFile(file, 'utf8'))
  rejected(ci(dir), /customPage may import components only/)
})
test('CI: unknown slot id fails', async () => {
  const dir = await fixture()
  const file = resolve(dir, 'ui/workers/-list.ts')
  await writeFile(file, (await readFile(file, 'utf8')).replace("'accessBadge'", "'unknownSlot'"))
  rejected(ci(dir), /Unknown slot unknownSlot/)
})
test('CI: parameter-name and index route collisions fail', () => {
  const value = customPage({ title: 'workers.trasa.title', uses: [], component: () => null })
  expect(() => getManifest({ 'ui/workers/$id.ts': value, 'ui/workers/$worker.ts': value }, schema, {})).toThrow(/Route collision/)
  expect(() => getManifest({ 'ui/workers.ts': value, 'ui/workers/index.ts': value }, schema, {})).toThrow(/Route collision/)
})
test('CI: slots receive declared fields and validated props only', async () => {
  const field = { kind: 'field' as const, type: 'userLink', parse(value: unknown) { return String(value) } }
  const slot = defineSlot({ modes: ['record'], props: { field }, render: () => null })
  expect(slotInput(slot, { field: 'user' }, { name: 'Secret name', user: 'u1', secret: 'secret' })).toEqual({ record: { user: 'u1' }, props: { field: 'user' } })
  expect(() => slotInput(slot, { field: 'user', secret: true }, {})).toThrow(/Unknown slot prop/)
})
test('CI: runtime rejects forged page objects and layout typos', async () => {
  expect(() => getManifest({ 'ui/a.ts': { title: 'workers.list.title' } }, schema, {})).toThrow(/SDK-branded/)
  const { entityDetailPage } = await import('@workbasehq/ui-v3')
  expect(() => getManifest({ 'ui/a.ts': entityDetailPage('workers', { kind: 'layout', nodes: ['nmae'], omit: [] }, { title: 'workers.detail.title' }) }, schema, {})).toThrow(/Unknown layout field nmae/)
})
