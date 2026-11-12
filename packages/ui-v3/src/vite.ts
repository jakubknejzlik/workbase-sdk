import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { resolve, relative, dirname } from 'node:path'
import { createServer, transformWithEsbuild, type Plugin } from 'vite'
import { init, parse } from 'es-module-lexer'
import { Generator, getConfig } from '@tanstack/router-generator'
import { checkSources, isRoute, uiFiles } from './check.ts'

export function manifestStubs(stubbed: string[] = []): Plugin {
  return {
    name: 'ui-v3-manifest-component-stubs', enforce: 'pre',
    async resolveId(id, importer) {
      if (id.startsWith('\0ui-v3-stub:')) return id
      const result = await this.resolve(id, importer, { skipSelf: true })
      if (result && (/\.tsx(?:\?|$)/.test(result.id) || result.id.includes('/-components/'))) return '\0ui-v3-stub:' + result.id
    },
    async load(id) {
      if (!id.startsWith('\0ui-v3-stub:')) return
      const file = id.slice('\0ui-v3-stub:'.length).split('?')[0]
      stubbed.push(file)
      if (/\.(css|svg|png)$/.test(file)) return 'export default {}'
      const code = await transformWithEsbuild(await readFile(file, 'utf8'), file, { loader: file.endsWith('.tsx') ? 'tsx' : 'ts' })
      await init
      const [, exports] = parse(code.code)
      // Lex export names, including named/default/re-exports; never evaluate the component or its imports.
      return exports.map((entry, index) => `const stub${index} = () => null; export { stub${index} as ${entry.n} };`).join('\n')
    },
  }
}

export async function extractManifest(root: string) {
  const started = performance.now()
  const stubbed: string[] = []
  const server = await createServer({ root, configFile: false, logLevel: 'error', plugins: [manifestStubs(stubbed)], server: { middlewareMode: true, watch: null }, appType: 'custom', ssr: { noExternal: ['@workbasehq/ui-v3'] } })
  try {
    const files = (await uiFiles(root)).filter(file => isRoute(root, file))
    const routes: Record<string, unknown> = {}
    for (const file of files) routes[relative(root, file)] = (await server.ssrLoadModule(file)).default
    const { getManifest } = await server.ssrLoadModule('@workbasehq/ui-v3')
    const { default: schema } = await server.ssrLoadModule(resolve(root, 'schema.ts'))
    const { default: slots } = await server.ssrLoadModule(resolve(root, 'ui/-slots.ts'))
    const manifest = getManifest(routes, schema, slots) as ReturnType<typeof import('./index').getManifest>
    const nav = (await server.ssrLoadModule(resolve(root, 'ui/nav.ts'))).default
    for (const item of nav) if (!manifest.some(route => route.path === item.path)) throw new Error(`Unknown nav path ${item.path}`)
    return { routes: manifest, nav, stubbed: stubbed.map(file => relative(root, file)), extractionMs: Math.round((performance.now() - started) * 100) / 100 }
  } finally { await server.close() }
}

export async function generateRouteWrappers(root: string) {
  const files = await checkSources(root)
  await extractManifest(root)
  const output = resolve(root, '.ui-v3/routes')
  await rm(output, { recursive: true, force: true })
  await mkdir(output, { recursive: true })
  await writeFile(resolve(output, '__root.tsx'), `import { createRootRoute } from '@tanstack/react-router'; import { Shell } from '@workbasehq/ui-v3/react'; export const Route = createRootRoute({ component: Shell });\n`)
  for (const file of files) {
    const target = resolve(output, relative(resolve(root, 'ui'), file))
    await mkdir(dirname(target), { recursive: true })
    const imported = relative(dirname(target), file).replaceAll('\\', '/')
    await writeFile(target, `import { createFileRoute, useParams } from '@tanstack/react-router';\nimport { createElement } from 'react';\nimport definition from '${imported}';\nimport { RouteView } from '@workbasehq/ui-v3/react';\nexport const Route = createFileRoute('/placeholder')({component: function View() { const params = useParams({strict: false}); return createElement(RouteView, {definition, params}); }});\n`)
  }
  await writeFile(resolve(root, '.ui-v3/pages.ts'), files.map((file, index) => `import page${index} from '${relative(resolve(root, '.ui-v3'), file).replaceAll('\\', '/')}';`).join('\n') + `\nexport default [${files.map((_, index) => `{ source: '${relative(root, files[index])}', definition: page${index} }`).join(', ')}];\n`)
  const config = getConfig({ target: 'react', routesDirectory: output, generatedRouteTree: resolve(root, '.ui-v3/routeTree.gen.ts'), quoteStyle: 'single', semicolons: false, disableLogging: true }, root)
  await new Generator({ config, root }).run()
}

export function uiV3(): Plugin {
  let root: string
  let generate: Promise<void> | undefined
  let closing = false
  return {
    name: 'ui-v3-route-wrappers',
    configResolved(config) { root = config.root },
    async buildStart() { generate ??= generateRouteWrappers(root); await generate },
    async closeBundle() { closing = true; await generate?.catch(() => {}) },
    configureServer(server) {
      server.watcher.add(['ui', 'schema.ts', 'config.ts'].map(name => resolve(root, name)))
      // Throwaway spike: regenerate then reload rather than patching a second route tree.
      server.watcher.on('all', (event, file) => {
        if (!closing && (file.startsWith(resolve(root, 'ui') + '/') || ['schema.ts', 'config.ts'].some(name => file === resolve(root, name))) && ['add', 'unlink', 'change'].includes(event)) {
          generate = (generate ?? Promise.resolve()).catch(() => {}).then(() => generateRouteWrappers(root))
          void generate.then(() => server.ws.send({ type: 'full-reload' })).catch(error => server.config.logger.error(String(error)))
        }
      })
    },
  }
}
