import { defineConfig, type ResolvedConfig } from 'vite'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, normalize, resolve } from 'node:path'
import ts from 'typescript'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
// Vite's new URL transform catches inline callback errors. Retain resolved paths
// and reject them again before Rollup can write any output.
const resolvedAssets = new Set<string>()
const privatePath = /\/(instances|examples)\/|\/fixtures\/private\/|\/snapshots\/|\/models\.gen\./
const cleanPath = (id: string) => id.split(/[?#]/, 1)[0].replaceAll('\\', '/')
function assertPublicPath(id: string) {
  const path = normalize(cleanPath(id)).replaceAll('\\', '/')
  const resolved = existsSync(path) ? realpathSync(path).replaceAll('\\', '/') : path
  if (privatePath.test(path) || privatePath.test(resolved)) throw new Error(`Private asset/module in public console: ${id}`)
}
let resolveAsset: ReturnType<ResolvedConfig['createResolver']>
let publicDirectory: string
// Keep locale keys with their values so the terminology gate can audit exact exceptions.
export default defineConfig({ json: { namedExports: false, stringify: false }, base: '/', plugins: [react(), tailwindcss(), {
  name: 'public-console-boundary',
  enforce: 'pre',
  configResolved(config) {
    publicDirectory = config.publicDir
    resolveAsset = config.createResolver({ extensions: [], mainFields: [], tryIndex: false, preferRelative: true })
  },
  buildStart() { resolvedAssets.clear() },
  load(id) { assertPublicPath(id) },
  async transform(code, id) {
    if (!/\bnew\s+URL\s*\(/.test(code) || !code.includes('import.meta.url')) return
    // Vite resolves these assets internally, bypassing module resolve/load hooks.
    // Parse original JS/TS/JSX so literals in comments and strings are ignored.
    const source = ts.createSourceFile(cleanPath(id), code, ts.ScriptTarget.Latest, true)
    const urls: string[] = []
    function visit(node: ts.Node) {
      if (ts.isNewExpression(node) && node.expression.getText(source) === 'URL' && node.arguments?.length === 2
        && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[1].getText(source) === 'import.meta.url') {
        urls.push(node.arguments[0].text)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    for (const url of urls) {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url)) continue
      const target = cleanPath(url)
      const file = target.startsWith('.') ? resolve(dirname(cleanPath(id)), target)
        : await resolveAsset(target, id) ?? (target.startsWith('/') ? resolve(publicDirectory, `.${target}`) : resolve(dirname(cleanPath(id)), target))
      assertPublicPath(file)
    }
  },
  generateBundle() {
    for (const id of [...this.getModuleIds(), ...this.getWatchFiles(), ...resolvedAssets]) assertPublicPath(id)
  },
}], build: { outDir: 'dist', assetsInlineLimit(path) { resolvedAssets.add(path); assertPublicPath(path); return undefined } } })
