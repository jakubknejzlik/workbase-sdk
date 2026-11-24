/** Read-only host boundary. Resolution is explicitly selected, never borrowed from host node_modules. */
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, extname, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { snapshot, type Snapshot } from './model'

export interface CaptureOptions {
  root: string; entry: string
  /** Exact package export -> source file, selected from the SDK snapshot by the caller. */
  packages?: Readonly<Record<string, string>>
  /** Reviewed summary dependency files. Contents are captured even when resolution is opaque. */
  dependencies?: readonly string[]
  maxModules?: number
}
export function capture(options: CaptureOptions): Snapshot {
  const root = realpathSync(options.root), sources: Record<string, string> = {}, dependencies: Record<string, string> = {}
  const resolutions: Snapshot['resolutions'][number][] = [], failures: { file: string; message: string }[] = []
  const id = (file: string) => relative(root, file).split(sep).join('/')
  const inside = (file: string) => file === root || file.startsWith(root + sep)
  const load = (name: string): string => {
    const file = realpathSync(resolve(root, name))
    if (!inside(file)) throw new Error('Source escapes selected snapshot root')
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(file))
  }
  for (const name of options.dependencies ?? []) {
    try { dependencies[name] = load(name) }
    catch { failures.push({ file: name, message: 'Cannot capture dependency bytes' }) }
  }
  const queue = [...new Set([options.entry, ...(options.dependencies ?? []).filter(file => /\.[cm]?[jt]sx?$/.test(file))])], queued = new Set(queue)
  while (queue.length) {
    const name = queue.shift()!
    if (Object.keys(sources).length >= (options.maxModules ?? 2048)) { failures.push({ file: name, message: 'Module budget exhausted' }); break }
    let text: string
    try { text = load(name); sources[name] = text }
    catch { failures.push({ file: name, message: 'Cannot capture source bytes' }); continue }
    const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true)
    const specs = new Set<string>()
    const visit = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specs.add(node.moduleSpecifier.text)
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) specs.add(node.arguments[0].text)
      ts.forEachChild(node, visit)
    }
    visit(source)
    for (const specifier of [...specs].sort()) {
      let target: string | undefined
      try {
        if (specifier.startsWith('.')) {
          const path = resolve(root, dirname(name), specifier)
          const candidates = (extname(path) ? [path] : [path + '.ts', path + '.tsx', resolve(path, 'index.ts')]).filter(file => { try { return statSync(file).isFile() } catch { return false } })
          if (candidates.length === 1 && inside(realpathSync(candidates[0]))) target = id(realpathSync(candidates[0]))
        } else if (options.packages?.[specifier]) {
          const path = realpathSync(resolve(root, options.packages[specifier]))
          if (inside(path)) target = id(path)
        }
      } catch { /* A missing/ambiguous edge remains explicit in the captured graph. */ }
      resolutions.push({ from: name, specifier, ...(target ? { target } : {}), identity: target ?? `unresolved:${specifier}` })
      if (target && !queued.has(target)) { queue.push(target); queued.add(target) }
    }
  }
  return snapshot({ entry: options.entry, sources, resolutions, dependencies, failures })
}
/** Conservative reviewed closure: all shipped implementation bytes, manifests and lock. */
export function sdkDependencyFiles(root: string): string[] {
  const result = ['bun.lock', 'package.json', 'packages/core/package.json', 'packages/plugins/package.json']
  const walk = (directory: string) => {
    for (const item of readdirSync(resolve(root, directory), { withFileTypes: true })) {
      const file = `${directory}/${item.name}`
      if (item.isDirectory()) { if (!['node_modules', 'test', 'tests', '__tests__', 'references'].includes(item.name)) walk(file) }
      else result.push(file)
    }
  }
  walk('packages/core/src')
  for (const item of readdirSync(resolve(root, 'packages/plugins'), { withFileTypes: true })) if (item.isDirectory()) {
    try { if (statSync(resolve(root, 'packages/plugins', item.name, 'src')).isDirectory()) walk(`packages/plugins/${item.name}/src`) } catch { /* no implementation */ }
  }
  return result.sort()
}
export function sdkPackages(root: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const pkg of ['core', 'plugins']) {
    const manifest = JSON.parse(readFileSync(resolve(root, `packages/${pkg}/package.json`), 'utf8'))
    for (const [key, value] of Object.entries(manifest.exports)) if (typeof value === 'string') result[manifest.name + (key === '.' ? '' : key.slice(1))] = `packages/${pkg}/${value.replace(/^\.\//, '')}`
  }
  return result
}
