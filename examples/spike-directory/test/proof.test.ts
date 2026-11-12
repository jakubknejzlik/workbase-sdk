import { afterEach, expect, test } from 'vitest'
import { cp, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { extractManifest, generateRouteWrappers, uiV3 } from '@workbasehq/ui-v3/vite'
import { customPage, getManifest, slotInput, defineSlot } from '@workbasehq/ui-v3'
import schema, { seed } from '../schema'
import { createMemoryStore } from '../../../packages/ui-v3/src/store'
import { createServer } from 'vite'
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
test('P2/P5: Node extraction returns all ten routes, layouts and dependencies without Leaflet execution', async () => {
  expect(typeof window).toBe('undefined')
  const raw = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('leaflet')"], { cwd: root, encoding: 'utf8' })
  rejected(raw, /window is not defined/)
  const result = await extractManifest(root)
  expect(result.routes.map(route => route.path).sort()).toEqual(['/jobs', '/jobs/$id', '/jobs/$id/edit', '/jobs/new', '/overview', '/workers', '/workers/$id', '/workers/$id/edit', '/workers/$id/trasa', '/workers/new'])
  expect(result.stubbed).toContain('ui/workers/-components/TrasaView.tsx')
  expect(result.routes.find(route => route.entity === 'workers' && route.mode === 'detail')?.uses).toEqual(['slot.booked', 'slot.job_id', 'slot.starts_at', 'worker.name', 'worker.user'])
  expect(result.routes.find(route => route.entity === 'workers' && route.mode === 'detail')?.layout?.nodes[1]).toMatchObject({ kind: 'columns' })
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
  await writeFile(file, (await readFile(file, 'utf8')).replace("name: { type: 'string', required: true }, ", ''))
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
  expect(() => getManifest({ 'ui/a.ts': entityDetailPage('workers', { entity: 'workers', kind: 'layout', nodes: ['nmae'], omit: [] }, { title: 'workers.detail.title' }) }, schema, {})).toThrow(/Unknown layout field nmae/)
})

function tsc(file: string) {
  return spawnSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--ignoreConfig', '--strict', '--skipLibCheck', '--target', 'ES2023', '--module', 'esnext', '--moduleResolution', 'bundler', '--jsx', 'react-jsx', '--esModuleInterop', file], { cwd: root, encoding: 'utf8' })
}
test('F5: entity and schema identity survive layout and page helpers', async () => {
  const dir = await fixture()
  const file = resolve(dir, 'negative.ts')
  await writeFile(file, `import { entityDetailPage, page } from '@workbasehq/ui-v3';
import layout from '../ui/workers/-detail.layout';
const correct = entityDetailPage('workers', layout, { title: 'test.correct' });
const correctPage = page({ entity: 'workers', layout, title: 'test.correct' });
// @ts-expect-error the returned page preserves its entity
const wrong: 'slots' = correct.entity!;
entityDetailPage('slots', layout, { title: 'test.wrong' });
page({ entity: 'slots', layout, title: 'test.wrong' });
`)
  const result = tsc(file)
  rejected(result, /not assignable/)
  expect(result.stdout).toContain('negative.ts(8,')
  expect(result.stdout).toContain('negative.ts(7,')
  expect(result.stdout).not.toContain('Unused')
  await writeFile(file, `import { entityDetailPage } from '@workbasehq/ui-v3';
import layout from '../ui/workers/-detail.layout';
const correct = entityDetailPage('workers', layout, { title: 'test.correct' });
// @ts-expect-error returned page preserves its layout field names
const badField: NonNullable<typeof correct.layout>['nodes'][number] = 'nmae';
`)
  const preserved = tsc(file)
  expect(preserved.status, preserved.stdout + preserved.stderr).toBe(0)
})
test.each(['.js', '.mjs', '.cjs', '.jsx', '.mts', '.cts'])('F4: transitive React in unsupported %s dependencies fails CI', async extension => {
  const dir = await fixture()
  const file = resolve(dir, 'ui/workers/-list.ts')
  await writeFile(file, `import './-react${extension}';\n` + await readFile(file, 'utf8'))
  await writeFile(resolve(dir, `ui/workers/-react${extension}`), "export { useState } from 'react'\n")
  rejected(ci(dir), /unsupported runtime data dependency extension/)
})
test.each(['workers.stats', '_layout', '(group)', 'workers_', 'workers[.]stats', 'route'])('F3: unsupported route grammar %s fails extraction and CI', async name => {
  const dir = await fixture()
  const value = customPage({ title: 'test.title', uses: [], component: () => null })
  expect(() => getManifest({ [`ui/${name}.ts`]: value }, schema, {})).toThrow(/Unsupported route filename/)
  await writeFile(resolve(dir, `ui/${name}.ts`), "import { page } from '@workbasehq/ui-v3'; export default page({ title: 'test.title' });\n")
  rejected(ci(dir), /Unsupported route filename/)
})
test('F3: accepted manifest paths match the generated TanStack tree', async () => {
  const dir = await fixture()
  await generateRouteWrappers(dir)
  const tree = await readFile(resolve(dir, '.ui-v3/routeTree.gen.ts'), 'utf8')
  for (const route of (await extractManifest(dir)).routes) expect(tree).toContain(`fullPath: '${route.path}'`)
})
test.each(['xs', 'sm', 'md', 'lg', 'xl'] as const)('5: span overflow at %s is rejected, with inherited spans and explicit stacks', async breakpoint => {
  const { defineUI, entityDetailPage } = await import('@workbasehq/ui-v3')
  const { layout, columns } = defineUI(schema, 'jobs', {})
  const input = layout([columns([[['title', 'client_id'], { xs: 12, [breakpoint]: 8 }], [['priority', 'status'], { xs: 12, [breakpoint]: 6 }]])])
  expect(() => getManifest({ 'ui/test.ts': entityDetailPage('jobs', input, { title: 'test.title' }) }, schema, {})).toThrow(`Columns exceed 12 at ${breakpoint}`)
  const valid = layout([columns([[['title', 'client_id'], { xs: 12, sm: 8 }], [['priority', 'status'], { xs: 12, sm: 4 }]])])
  expect(() => getManifest({ 'ui/test.ts': entityDetailPage('jobs', valid, { title: 'test.title' }) }, schema, {})).not.toThrow()
})
test('3: generic relation filtering follows schema foreign keys for both entities', () => {
  const store = createMemoryStore(schema, seed)
  expect(store.related('workers', 'w1', 'slots').map(row => row.id)).toEqual(['s1', 's2'])
  expect(store.related('workers', 'w2', 'slots').map(row => row.id)).toEqual(['s3'])
  expect(store.related('jobs', 'j1', 'slots').map(row => row.id)).toEqual(['s1'])
  expect(store.related('jobs', 'j2', 'slots').map(row => row.id)).toEqual(['s2', 's3'])
})
test('2: memory store persists independent typed fields and preserves readOnly defaults', () => {
  const store = createMemoryStore(schema, seed)
  const saved = store.save('jobs', undefined, { title: 'New visit', client_id: 'c2', priority: 'high', status: 'done' })
  expect(store.get('jobs', saved.id)).toEqual({ id: saved.id, title: 'New visit', client_id: 'c2', priority: 'high', status: 'draft' })
  store.save('jobs', saved.id, { title: 'Changed', client_id: 'c1', priority: 'low' })
  expect(store.get('jobs', saved.id)).toMatchObject({ title: 'Changed', client_id: 'c1', priority: 'low' })
  expect(() => store.save('jobs', undefined, { title: 'Bad', client_id: 'missing', priority: 'high' })).toThrow(/Unknown reference/)
  expect(store.list('jobs')).toHaveLength(3)
})
test('F2: real Vite watcher recovers after invalid edit, then adds/removes routes', async () => {
  const dir = await fixture()
  const errors: string[] = []
  const server = await createServer({ root: dir, configFile: false, plugins: [uiV3()], logLevel: 'silent', server: { host: '127.0.0.1', port: 0 }, customLogger: { ...((await import('vite')).createLogger('silent')), error(message) { errors.push(message) } } })
  async function until(check: () => Promise<boolean>) {
    const deadline = Date.now() + 12000
    while (Date.now() < deadline) { if (await check()) return; await new Promise(done => setTimeout(done, 80)) }
    throw new Error('Dev regeneration timed out: ' + errors.join('\n'))
  }
  try {
    await server.listen()
    await new Promise(done => setTimeout(done, 150))
    const file = resolve(dir, 'ui/workers/-detail.layout.ts')
    const original = await readFile(file, 'utf8')
    await writeFile(file, original.replace("'name'", "'nmae'"))
    await until(async () => errors.some(error => error.includes('Unknown layout field nmae')))
    await writeFile(file, original)
    const added = resolve(dir, 'ui/recovered.ts')
    await writeFile(added, "import { page } from '@workbasehq/ui-v3'; export default page({ title: 'test.recovered' });\n")
    const generated = resolve(dir, '.ui-v3/routeTree.gen.ts')
    await until(async () => (await readFile(generated, 'utf8').catch(() => '')).includes("fullPath: '/recovered'"))
    await rm(added)
    await until(async () => !(await readFile(generated, 'utf8')).includes("fullPath: '/recovered'"))
    console.log('F2 DEV_RECOVERY invalid edit -> fix -> add/remove route verified')
  } finally { await server.close() }
}, 30000)
