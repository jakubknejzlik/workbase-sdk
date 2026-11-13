import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync, unlinkSync, readdirSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createServer, build, type ViteDevServer } from 'vite'
import { afterEach, expect, test, vi } from 'vitest'
import { consoleUI, extractManifest } from '../src/vite'
import { canonicalJSON, manifestHash, SourceError } from '../src/check'
import * as sourceChecks from '../src/sources'
import { buildPath } from '../src/index'
import { fixture, declaration, sdk, forbidden } from './fixture'
const roots: string[] = [], servers: ViteDevServer[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(s => s.close())); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })
function setup() { const f = fixture(); roots.push(f.root); return f }
async function start(root: string) {
  const plugin = consoleUI()
  // Polling events are spaced beyond Chokidar's 50 ms change deduplication.
  let ready!: Promise<void>
  const server = await createServer({ root, configFile: false, plugins: [{ name: 'watcher-ready', configureServer(server) {
    ready = (server.watcher as typeof server.watcher & { _readyEmitted?: boolean })._readyEmitted
      ? Promise.resolve() : new Promise(resolve => server.watcher.once('ready', resolve))
  } }, plugin], logLevel: 'silent', server: { middlewareMode: true, ws: false, watch: { usePolling: true, interval: 100, atomic: false } }, appType: 'custom' })
  servers.push(server)
  await ready
  await plugin.idle()
  if (plugin.error) throw plugin.error
  return { plugin, server }
}
function snapshot(root: string) {
  return { manifest: readFileSync(join(root, '.workbase-ui/manifest.json'), 'utf8'), tree: readFileSync(join(root, '.workbase-ui/routeTree.gen.ts'), 'utf8'), generation: JSON.parse(readFileSync(join(root, '.workbase-ui/generation.json'), 'utf8')) }
}
test('extraction stubs browser imports; manifest is byte-identical twice', async () => {
  const { root, put } = setup()
  put('ui/-components/widget.tsx', `if (!('window' in globalThis)) throw new Error('BROWSER_ONLY'); export default function Widget() { return 'REAL_COMPONENT_MARKER' }`)
  put('ui/index.ts', `import { customPage } from '${sdk}'; import Widget from './-components/widget'; export default customPage({ title: 'sample.title', uses: [], component: Widget })`)
  const first = await extractManifest(root), second = await extractManifest(root)
  expect(canonicalJSON(first)).toBe(canonicalJSON(second))
  expect(manifestHash(first)).toBe(manifestHash(second))
  expect(first.routes[0].kind).toBe('customPage')
  expect(canonicalJSON(first)).not.toContain('component')
})
test.each(['id', 'workerId'])('declared $%s: manifest → TanStack tree → buildPath', async recordParam => {
  const { root, put } = setup()
  put('ui/workers/index.ts', `import { entityListPage } from '${sdk}'; export default entityListPage('worker', { title: 'worker.list' })`)
  put(`ui/workers/$${recordParam}/index.ts`, `import { entityDetailPage } from '${sdk}'; export default entityDetailPage('worker', { title: 'worker.detail', recordParam: '${recordParam}' })`)
  put(`ui/workers/$${recordParam}/edit.ts`, `import { entityEditPage } from '${sdk}'; export default entityEditPage('worker', { title: 'worker.edit', recordParam: '${recordParam}' })`)
  const { plugin } = await start(root), { manifest, paths } = plugin.generation!
  const link = manifest.routes.find(r => r.mode === 'list')!.links.detail!
  expect(link).toEqual({ to: `/workers/$${recordParam}`, bind: { [recordParam]: 'record.id' } })
  expect(paths).toContain(link.to)
  expect(snapshot(root).tree).toContain(`/workers/$${recordParam}`)
  expect(buildPath(link.to, Object.fromEntries(Object.keys(link.bind).map(key => [key, 'record-7'])))).toBe('/workers/record-7')
})
test('real watcher: invalid → fix → add page → remove page → add schema; keeps last good tree', async () => {
  const { root, put } = setup(), { plugin, server } = await start(root)
  let rebuilt: (() => void) | undefined
  const sends = vi.spyOn(server.ws, 'send').mockImplementation(message => {
    const payload = message as unknown as { type?: string }
    if (['error', 'full-reload'].includes(payload?.type ?? '')) rebuilt?.()
  })
  async function edit(file: string, operation: () => void) {
    const path = join(root, file)
    const rebuild = new Promise<void>(resolve => { rebuilt = resolve })
    const event = new Promise<void>(resolve => {
      const handler = (_event: string, changed: string) => { if (changed === path) { server.watcher.off('all', handler); resolve() } }
      server.watcher.on('all', handler)
    })
    operation(); await event; await rebuild; await plugin.idle(); rebuilt = undefined
  }
  const original = snapshot(root)
  await server.transformRequest('/.workbase-ui/routeTree.gen.ts')
  await edit('ui/index.ts', () => put('ui/index.ts', `import x from 'unclassified'; throw new Error('EVALUATED'); ${declaration}`))
  expect(plugin.error).toBeInstanceOf(SourceError)
  expect(snapshot(root)).toEqual(original)
  expect(sends.mock.calls.some(call => (call as unknown as [{ type?: string }])[0]?.type === 'error')).toBe(true)
  await edit('ui/index.ts', () => put('ui/index.ts', declaration.replace('sample.title', 'sample.fixed')))
  expect(plugin.error).toBeUndefined()
  const fixed = snapshot(root)
  expect(fixed.generation.manifestHash).not.toBe(original.generation.manifestHash)
  expect(fixed.generation.paths).toEqual(['/'])
  await edit('ui/x.ts', () => put('ui/x.ts', declaration))
  const added = snapshot(root)
  expect(added.generation.paths).toEqual(['/', '/x'])
  expect(added.generation.manifestHash).not.toBe(fixed.generation.manifestHash)
  expect(added.tree).toContain("'/x'")
  expect((await server.transformRequest('/.workbase-ui/routeTree.gen.ts'))!.code).toContain('/x')
  await edit('ui/x.ts', () => unlinkSync(join(root, 'ui/x.ts')))
  expect(snapshot(root)).toEqual(fixed)
  const calls = sends.mock.calls.length
  await edit('schema/y.ts', () => put('schema/y.ts', `throw new Error('SCHEMA_NOT_IMPORTED')`))
  expect(plugin.error).toBeUndefined()
  expect(snapshot(root)).toEqual(fixed)
  expect(sends.mock.calls.length).toBeGreaterThan(calls)
  expect(sends.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'full-reload' })
}, 60000)
test('app build retains real component marker, extraction stubs never leak', async () => {
  const { root, put } = setup()
  put('ui/-components/widget.tsx', `export default function Widget() { return 'REAL_COMPONENT_MARKER' }`)
  put('ui/index.ts', `import { customPage } from '${sdk}'; import Widget from './-components/widget'; export default customPage({ title: 'sample.title', uses: [], component: Widget })`)
  put('index.html', '<script type="module" src="/entry.ts"></script>')
  put('entry.ts', `import { routeTree } from './.workbase-ui/routeTree.gen'; console.log(routeTree)`)
  const plugin = consoleUI()
  await build({ root, configFile: false, logLevel: 'silent', plugins: [plugin], resolve: { alias: { '@tanstack/react-router': resolve('packages/frontend-console/node_modules/@tanstack/react-router') } }, build: { minify: false } })
  const bundle = readdirSync(join(root, 'dist/assets')).filter(f => f.endsWith('.js')).map(f => readFileSync(join(root, 'dist/assets', f), 'utf8')).join('\n')
  expect(bundle).toContain('REAL_COMPONENT_MARKER')
  expect(bundle).not.toContain('workbase-ui-component:')
})
test('latest edit wins while regeneration is in flight', async () => {
  const { root, put } = setup(), { plugin, server } = await start(root)
  put('ui/index.ts', declaration.replace('sample.title', 'sample.second'))
  server.watcher.emit('all', 'change', join(root, 'ui/index.ts'))
  put('ui/index.ts', declaration.replace('sample.title', 'sample.latest'))
  server.watcher.emit('all', 'change', join(root, 'ui/index.ts'))
  await plugin.idle()
  expect(plugin.error).toBeUndefined()
  expect(plugin.generation!.manifest.routes[0].title).toBe('sample.latest')
  expect(readdirSync(root).filter(f => f.includes('.stage-') || f.includes('.next-'))).toEqual([])
})

test.each(forbidden)('extraction rejects graph before evaluation: %s', async (_name, edge, file, content) => {
  const { root, put } = setup()
  put('ui/index.ts', edge + '\nthrow new Error("EVALUATED")\n' + declaration)
  if (file) put(file, 'throw new Error("EVALUATED")\n' + content)
  const error = await extractManifest(root).catch(error => error)
  expect(error).toBeInstanceOf(SourceError)
  expect(error.message).toMatch(/:\d+:\d+:/)
  expect(error.message).not.toContain('EVALUATED')
})

test('loadConfig precedes source checking and never evaluates config or schema', async () => {
  const { root, put } = setup()
  put('ui/index.ts', `import x from 'unknown'; ${declaration}`)
  put('config.ts', `throw new Error('CONFIG_EVALUATED')`)
  const error = await extractManifest(root).catch(error => error)
  expect(error).toBeInstanceOf(SourceError)
  expect(error.message).toContain('config.ts:')
  expect(error.message).not.toContain('CONFIG_EVALUATED')
})

test('slot component with named exports is stubbed while prop specs stay data', async () => {
  const { root, put } = setup()
  put('ui/-components/widget.tsx', `const browser = window; export function Widget() { return browser }`)
  put('ui/-slots.ts', `import { p } from '${sdk}'; import { defineSlots as slots } from '${sdk}'; import { Widget } from './-components/widget'; export default slots({ sample: { contexts: ['record'], props: { name: p.field('text') }, component: Widget } })`)
  put('ui/index.ts', `import { page, slot } from '${sdk}'; export default page({ title: 'worker.title', entity: 'worker', layout: [slot('sample', { name: 'name' })] })`)
  expect((await extractManifest(root)).slots.sample).toEqual({ contexts: ['record'], props: { name: { kind: 'field', type: 'text' } } })
})

test('unclassified symlinks are rejected before evaluation', async () => {
  const { root, put } = setup()
  put('browser.ts', 'throw new Error("EVALUATED"); export default {}')
  symlinkSync(join(root, 'browser.ts'), join(root, 'ui/-bridge.ts'))
  put('ui/index.ts', `import x from './-bridge'; throw new Error('EVALUATED'); ${declaration}`)
  const error = await extractManifest(root).catch(error => error)
  expect(error).toBeInstanceOf(SourceError)
  expect(error.message).toMatch(/-bridge.ts:1:1: Unclassified UI symlink/)
  expect(error.message).not.toContain('EVALUATED')
})

test.each(['eager', 'lazy'])('glob-%s is rejected before unchecked code executes', async mode => {
  const { root, put } = setup()
  put('ui/-evil.ts', 'throw new Error("UNCHECKED_EXECUTED"); export const x = 1')
  const glob = mode === 'eager' ? "import.meta.glob('./-evil.ts', { eager: true })" : "import.meta.glob('./-evil.ts')['./-evil.ts']()"
  put('ui/index.ts', `${declaration}\nawait ${glob}`)
  await expect(extractManifest(root)).rejects.toThrow(/index.ts:3:.*[Uu]nclassified/)
})
test('inline-type-only-verbatim rejects schema before evaluation', async () => {
  const { root, put } = setup()
  put('tsconfig.json', '{"compilerOptions":{"verbatimModuleSyntax":true}}')
  put('schema/unchecked.ts', 'throw new Error("SCHEMA_EXECUTED"); export type x = string')
  put('ui/index.ts', `import { type x } from '../schema/unchecked'\n${declaration}`)
  await expect(extractManifest(root)).rejects.toThrow(/index.ts:1:.*Value import outside ui/)
})
test('prototype-extract rejects own __proto__ search key', async () => {
  const { root, put } = setup()
  put('ui/index.ts', declaration.replace("title: 'sample.title'", `title: 'sample.title', search: JSON.parse('{"__proto__":{"kind":"string"}}')`))
  await expect(extractManifest(root)).rejects.toThrow(/index.ts:2:16: Forbidden.*__proto__/)
})
test.each(['entry', 'ui', 'outside', 'query'])('extraction denies unchecked %s module instead of falling through', async kind => {
  const { root, put } = setup(), sources = sourceChecks.checkSources(root)
  const modules = sources.modules as Map<string, string>, entry = join(root, 'ui/index.ts')
  if (kind === 'entry') modules.delete(entry)
  else {
    const target = kind === 'outside' ? '../unchecked.ts' : './-unchecked.ts'
    put(kind === 'outside' ? 'unchecked.ts' : 'ui/-unchecked.ts', 'throw new Error("UNCHECKED_EXECUTED"); export const x = 1')
    modules.set(entry, `import { x } from '${target}${kind === 'query' ? '?raw' : ''}'; console.log(x); ${declaration}`)
  }
  const checked = vi.spyOn(sourceChecks, 'checkSources').mockReturnValueOnce(sources)
  try { await expect(extractManifest(root)).rejects.toThrow(/not in the checked UI graph/) }
  finally { checked.mockRestore() }
})
test('generated wrappers bind the real renderer, manifest metadata, parameters and live slots', async () => {
  const { root, put } = setup()
  put('ui/-components/card.tsx', `export default function Card() { return 'LIVE_SLOT_MARKER' }`)
  put('ui/-slots.ts', `import { defineSlots, p } from '${sdk}'; import Card from './-components/card'; export default defineSlots({ card: { contexts: ['record'], props: { name: p.field('text') }, component: Card } })`)
  put('ui/workers/$workerId/index.ts', `import { entityDetailPage, slot } from '${sdk}'; export default entityDetailPage('worker', { title: 'worker.detail', recordParam: 'workerId', layout: [slot('card', { name: 'name' })] })`)
  await start(root)
  const view = readFileSync(join(root, '.workbase-ui/RouteView.ts'), 'utf8')
  const wrapper = readFileSync(join(root, '.workbase-ui/routes/workers/$workerId/index.ts'), 'utf8')
  expect(view).toContain("from '@workbasehq/plugins/console/ui/react'")
  expect(wrapper).toContain('manifest.entities'); expect(wrapper).toContain('Route.useParams()'); expect(wrapper).toContain('Route.useSearch()')
  expect(wrapper).toContain('parseParams(definition.search, search)'); expect(wrapper).toContain('parseParams(definition.params, params)')
  expect(wrapper).toContain('ui/-slots.ts'); expect(view).not.toContain('Placeholder')
})

test('generated four-route consumer passes strict TypeScript checking', async () => {
  const { root, put } = setup()
  for (const [file, helper, extra] of [
    ['index.ts', 'entityListPage', ''], ['new.ts', 'entityCreatePage', ', layout: ["name"]'],
    ['$workerId/index.ts', 'entityDetailPage', ', recordParam: "workerId", layout: ["name"]'],
    ['$workerId/edit.ts', 'entityEditPage', ', recordParam: "workerId", layout: ["name"]'],
  ]) put('ui/workers/' + file, `import { ${helper} } from '${sdk}'; export default ${helper}('worker', { title: 'worker.title'${extra} })`)
  await start(root)
  put('entry.ts', `import { createRouter } from '@tanstack/react-router'; import { routeTree } from './.workbase-ui/routeTree.gen'; const router = createRouter({ routeTree }); declare module '@tanstack/react-router' { interface Register { router: typeof router } }`)
  const checked = spawnSync('bun', [resolve('node_modules/typescript/bin/tsc'), '--ignoreConfig', '--strict', '--noEmit', '--skipLibCheck', '--moduleResolution', 'bundler', '--module', 'esnext', '--target', 'es2023', '--allowImportingTsExtensions', '--resolveJsonModule', '--esModuleInterop', '--types', 'node,@cloudflare/workers-types', join(root, 'entry.ts')], { encoding: 'utf8' })
  expect(checked.status, checked.stdout + checked.stderr).toBe(0)
}, 20000)
