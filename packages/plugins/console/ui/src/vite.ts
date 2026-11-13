import { randomUUID } from 'node:crypto'
import { statSync, existsSync, readFileSync } from 'node:fs'
import { mergeCatalogs, type Catalogs } from './catalogs'
import { writeFile, mkdir, rm, rename, symlink, readlink } from 'node:fs/promises'
import { dirname, relative, resolve, isAbsolute } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { createServer, transformWithEsbuild, type Plugin, type ViteDevServer } from 'vite'
import { init, parse } from 'es-module-lexer'
import { Generator, getConfig } from '@tanstack/router-generator'
import { loadConfig, SourceError } from '@workbasehq/core/schema/load'
import { canonicalJSON, normalise, manifestHash, type Manifest } from './check'
import { checkSources, type Sources } from './sources'

/** Private to extraction: this plugin is never installed into the application. */
function componentStubs(sources: Sources): Plugin {
  const prefix = '\0workbase-ui-component:', ui = resolve(sources.root, 'ui') + '/'
  const sdkFile = fileURLToPath(new URL('./index.ts', import.meta.url))
  const clean = (id: string) => id.replace(/^\/@fs\//, '/').split(/[?#]/)[0]
  function requireChecked(id: string) {
    const file = clean(id)
    if (id !== file || !sources.modules.has(file)) throw new Error(`Module not in the checked UI graph: ${id}`)
    return file
  }
  return {
    name: 'workbase-ui-extraction-stubs', enforce: 'pre',
    async resolveId(id, importer) {
      if (id === '@workbasehq/plugins/console/ui/react' && importer && sources.modules.has(clean(importer))) return '\0workbase-ui-access-card'
      if (id.startsWith(prefix)) { requireChecked(id.slice(prefix.length)); return id }
      const fromUI = importer && sources.modules.has(clean(importer))
      const result = await this.resolve(id, importer, { skipSelf: true })
      const file = result && clean(result.id)
      // Only the exact SDK entry is a trusted edge out of the checked graph.
      if (file && (file.startsWith(ui) || fromUI && result!.id !== sdkFile)) {
        requireChecked(result!.id)
        return sources.components.has(file) ? prefix + file : file
      }
      const requested = id.startsWith('.') && importer ? resolve(dirname(clean(importer)), clean(id)) : clean(id)
      if (!result && (fromUI || requested.startsWith(ui))) throw new Error(`Module not in the checked UI graph: ${id}`)
    },
    async load(id) {
      if (id === '\0workbase-ui-access-card') return 'export const AccessCard = () => null;'
      // Evaluate the exact text whose complete graph passed checkSources.
      if (!id.startsWith(prefix)) {
        const file = clean(id)
        if (file.startsWith(ui) || sources.modules.has(file)) return sources.modules.get(requireChecked(id))!
        return
      }
      const file = requireChecked(id.slice(prefix.length))
      const transformed = await transformWithEsbuild(sources.modules.get(file)!, file, { loader: /[jt]sx$/.test(file) ? 'tsx' : 'ts' })
      await init
      const [, exports] = parse(transformed.code)
      return exports.map((entry, index) => `const c${index} = () => null; export { c${index} as ${JSON.stringify(entry.n)} };`).join('\n')
    },
  }
}
export async function extractManifest(root: string): Promise<Manifest> {
  root = resolve(root)
  const loaded = await loadConfig(resolve(root, 'config.ts'))
  const sources = checkSources(root)
  // The server does not exist until the complete source graph has passed.
  const server = await createServer({
    root, configFile: false, logLevel: 'silent', appType: 'custom',
    plugins: [componentStubs(sources)],
    resolve: { alias: [{ find: /^@workbasehq\/plugins\/console\/ui$/, replacement: fileURLToPath(new URL('./index.ts', import.meta.url)) }] },
    server: { middlewareMode: true, watch: null, ws: false },
    ssr: { noExternal: ['@workbasehq/plugins'] },
  })
  try {
    const values: Record<string, unknown> = {}
    for (const entry of sources.entries) {
      try { values[entry.source] = (await server.ssrLoadModule(entry.file)).default }
      catch (error) { throw new SourceError(entry.location, error instanceof Error ? error.message : String(error)) }
    }
    return normalise(sources, values, loaded.config.entities, loaded.configHash)
  } finally { await server.close() }
}
export type Generation = { manifest: Manifest; manifestHash: string; paths: string[] }
export async function generateRoutes(root: string, directory: string, manifest: Manifest): Promise<string[]> {
  const routes = resolve(directory, 'routes')
  await mkdir(routes, { recursive: true })
  await writeFile(resolve(routes, '__root.tsx'), `import { createRootRoute, Outlet } from '@tanstack/react-router'; export const Route = createRootRoute({ component: Outlet });\n`)
  await writeFile(resolve(directory, 'RouteView.ts'), `export { RouteView } from '@workbasehq/plugins/console/ui/react';\nexport { createElement } from 'react';\nexport { parseParams } from '@workbasehq/plugins/console/ui';\n`)
  for (const route of manifest.routes) {
    const target = resolve(routes, relative('ui', route.source))
    await mkdir(dirname(target), { recursive: true })
    const imported = relative(dirname(target), resolve(root, route.source)).replaceAll('\\', '/')
    const view = relative(dirname(target), resolve(directory, 'RouteView.ts')).replaceAll('\\', '/')
    const metadata = relative(dirname(target), resolve(directory, 'manifest.json')).replaceAll('\\', '/')
    const slotsFile = resolve(root, 'ui/-slots.ts')
    const slotsImport = Object.keys(manifest.slots).length ? `import slots from ${JSON.stringify(relative(dirname(target), slotsFile).replaceAll('\\', '/'))};\n` : 'const slots = {};\n'
    await writeFile(target, `import { createFileRoute } from '@tanstack/react-router';\nimport definition from ${JSON.stringify(imported.startsWith('.') ? imported : './' + imported)};\nimport { RouteView, createElement, parseParams } from ${JSON.stringify(view.startsWith('.') ? view : './' + view)};\nimport metadata from ${JSON.stringify(metadata.startsWith('.') ? metadata : './' + metadata)};\nimport type { Manifest } from '@workbasehq/plugins/console/ui/check';\n${slotsImport}const manifest = metadata as unknown as Manifest;\nexport const Route = createFileRoute('/placeholder')({ validateSearch: (search) => parseParams(definition.search, search), params: { parse: (params) => { parseParams(definition.params, params); return params } }, component: View, staticData: { definition } });\nfunction View(): ReturnType<typeof createElement> { return createElement(RouteView, { definition, route: manifest.routes.find(r => r.path === ${JSON.stringify(route.path)})!, entities: manifest.entities, routes: manifest.routes, params: parseParams(definition.params, Route.useParams()), search: Route.useSearch(), slots }) }\n`)
  }
  const generator = new Generator({ root, config: getConfig({ target: 'react', routesDirectory: routes, generatedRouteTree: resolve(directory, 'routeTree.gen.ts'), disableLogging: true, quoteStyle: 'single', semicolons: false, tmpDir: resolve(directory, '-tmp') }, root) })
  await generator.run()
  const paths = [...generator.getRoutesByFileMap().values()].filter(value => value.routePath !== '/__root').map(value => value.routePath.replace(/\/$/, '') || '/').sort()
  const expected = manifest.routes.map(route => route.path).sort()
  if (canonicalJSON(paths) !== canonicalJSON(expected)) throw new Error(`Generated route paths differ from manifest: ${JSON.stringify(paths)}`)
  return paths
}
/** Build completely beside the current tree; one symlink rename publishes it. */
async function stage(root: string, output: string): Promise<{ result: Generation; publish: (current: () => boolean) => Promise<boolean>; discard: () => Promise<void> }> {
  const token = randomUUID(), temp = output + '.stage-' + token, final = output + '.generation-' + token, pointer = output + '.next-' + token
  const discard = async () => { for (const path of [temp, final, pointer]) await rm(path, { recursive: true, force: true }) }
  try {
    const manifest = await extractManifest(root)
    const paths = await generateRoutes(root, temp, manifest)
    const loaded = await loadConfig(resolve(root, 'config.ts')), catalogs: Catalogs = {}
    for (const lang of loaded.config.languages ?? []) {
      catalogs[lang] = {}
      for (const ns of ['domain', 'ui', 'sdk']) {
        const file = resolve(root, 'locales', lang, ns + '.json')
        if (existsSync(file)) catalogs[lang][ns] = JSON.parse(readFileSync(file, 'utf8'))
      }
    }
    await writeFile(resolve(temp, 'locales.json'), canonicalJSON(mergeCatalogs(loaded.config.languages ?? ['en'], catalogs)) + '\n')
    await writeFile(resolve(temp, 'manifest.json'), canonicalJSON(manifest) + '\n')
    const result = { manifest, manifestHash: manifestHash(manifest), paths }
    await writeFile(resolve(temp, 'generation.json'), canonicalJSON({ manifestHash: result.manifestHash, paths }) + '\n')
    await rename(temp, final)
    return { result, discard, publish: async current => {
      const previous = await readlink(output).catch(() => undefined)
      await symlink(relative(dirname(output), final), pointer, 'dir')
      if (!current()) { await discard(); return false }
      await rename(pointer, output)
      if (previous) {
        const old = resolve(dirname(output), previous)
        if (old.startsWith(output + '.generation-')) await rm(old, { recursive: true, force: true }).catch(() => {})
      }
      return true
    } }
  } catch (error) { await discard(); throw error }
}
export interface UIOptions { directory?: string }
export type UIPlugin = Plugin & { idle(): Promise<void>; generation?: Generation; error?: Error }
export function consoleUI(options: UIOptions = {}): UIPlugin {
  let root: string, output: string, server: ViteDevServer | undefined
  let requested = 0, completed = 0, running: Promise<void> | undefined, closed = false
  const plugin: UIPlugin = {
    name: 'workbase-console-ui', enforce: 'pre',
    // Keep generated IDs at the stable pointer. Vite's module graph otherwise
    // retains realpaths into deleted generations even after invalidateAll().
    resolveId(id, importer) {
      if (!output || id.startsWith('\0')) return
      const index = id.indexOf('?'), clean = index < 0 ? id : id.slice(0, index), query = index < 0 ? '' : id.slice(index)
      const path = clean.startsWith('/@fs/') ? clean.slice(4) : clean
      const candidate = path.startsWith(output + '/') ? path
        : path.startsWith('.') && importer ? resolve(dirname(importer.split('?')[0]), path)
        : path.startsWith('/') ? resolve(root, '.' + path) : undefined
      if (!candidate?.startsWith(output + '/')) return
      for (const file of [candidate, candidate + '.ts', candidate + '.tsx']) {
        try { if (statSync(file).isFile()) return file + query } catch { /* Let Vite report a missing generated import. */ }
      }
    },
    configResolved(config) { root = config.root; output = resolve(root, options.directory ?? '.workbase-ui') },
    async buildStart() { if (!requested) request(); await plugin.idle(); if (plugin.error && !server) throw plugin.error },
    configureServer(value) {
      server = value
      const watched = ['config.ts', 'access.ts', 'schema', 'ui', 'locales'].map(path => resolve(root, path))
      server.watcher.add(watched)
      const handler = (event: string, file: string) => {
        const path = isAbsolute(file) ? resolve(file) : resolve(root, file)
        if (!closed && ['add', 'change', 'unlink', 'addDir', 'unlinkDir'].includes(event) && watched.some(prefix => path === prefix || path.startsWith(prefix + '/'))) request()
      }
      server.watcher.on('all', handler)
      server.httpServer?.once('close', () => { closed = true; server?.watcher.off('all', handler) })
      request()
    },
    async closeBundle() { closed = true; await plugin.idle() },
    async idle() { while (running) await running },
  }
  function request() {
    requested++
    if (!running) running = drain().finally(() => { running = undefined; if (completed < requested && !closed) request() })
  }
  async function drain() {
    while (completed < requested && !closed) {
      const revision = requested
      try {
        const staged = await stage(root, output)
        if (revision !== requested || closed) { await staged.discard(); continue }
        try { if (!await staged.publish(() => revision === requested && !closed)) continue } catch (error) { await staged.discard(); throw error }
        plugin.generation = staged.result; plugin.error = undefined
        server?.moduleGraph.invalidateAll()
        server?.ws.send({ type: 'full-reload' })
      } catch (error) {
        if (revision === requested) {
          plugin.error = error instanceof Error ? error : new Error(String(error))
          server?.ws.send({ type: 'error', err: { message: plugin.error.message, stack: plugin.error.stack ?? '', plugin: plugin.name } })
        }
      }
      completed = revision
    }
  }
  return plugin
}
