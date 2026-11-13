import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs'
import { dirname, extname, relative, resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import ts from 'typescript'
import { sdkBinding, SourceError, type SourceLocation } from '@workbasehq/core/schema/load'
export { SourceError }
const sdk = '@workbasehq/plugins/console/ui'
const sdkFile = fileURLToPath(new URL('./index.ts', import.meta.url))
const helpers = ['page', 'customPage', 'entityListPage', 'entityDetailPage', 'entityCreatePage', 'entityEditPage']
export interface Entry { file: string; source: string; location: SourceLocation; helper: string; path?: string }
export interface Sources { root: string; entries: Entry[]; components: Set<string>; modules: ReadonlyMap<string, string> }
const checked = new WeakSet<Sources>()
export function assertChecked(sources: Sources) { if (!checked.has(sources)) throw new Error('Expected checkSources result') }
function location(node: ts.Node): SourceLocation {
  const file = node.getSourceFile(), pos = file.getLineAndCharacterOfPosition(node.getStart(file))
  return { file: file.fileName, line: pos.line + 1, column: pos.character + 1 }
}
function fail(node: ts.Node, message: string): never { throw new SourceError(location(node), message) }
export function routePath(source: string): string {
  const parts = source.replace(/^ui\//, '').replace(/\.ts$/, '').split('/')
  if (parts.some(part => !/^(?:[a-zA-Z][a-zA-Z0-9-]*|\$[a-zA-Z][a-zA-Z0-9]*)$/.test(part) || part === 'route') || parts.slice(0, -1).includes('index')) throw new Error(`Unsupported route filename: ${source}`)
  return '/' + parts.filter(part => part !== 'index').join('/')
}
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = resolve(dir, entry.name)
    if (entry.isSymbolicLink()) throw new SourceError({ file, line: 1, column: 1 }, 'Unclassified UI symlink')
    return entry.isDirectory() ? files(file) : [file]
  }).sort()
}
function namedBindings(tree: ts.SourceFile) {
  const bindings = new Map<string, { module: string; imported: string; node: ts.StringLiteral }>()
  for (const statement of tree.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && !statement.importClause?.isTypeOnly) {
    const names = statement.importClause?.namedBindings
    if (names && ts.isNamedImports(names)) for (const item of names.elements) if (!item.isTypeOnly) bindings.set(item.name.text, { module: statement.moduleSpecifier.text, imported: (item.propertyName ?? item.name).text, node: statement.moduleSpecifier })
  }
  return bindings
}
/** Fail closed: every runtime edge is SDK, local data, or a browser component. */
export function checkSources(root: string): Sources {
  root = realpathSync(root)
  const ui = resolve(root, 'ui'), entries: Entry[] = [], components = new Set<string>()
  const cache = new Map<string, ts.SourceFile>()
  function read(file: string) {
    if (!cache.has(file)) {
      const text = readFileSync(file, 'utf8')
      const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
      let diagnostics: readonly ts.Diagnostic[]
      try { diagnostics = ts.transpileModule(text, { fileName: file, reportDiagnostics: true }).diagnostics ?? [] } catch { fail(tree, 'Unclassified source syntax') }
      if (diagnostics.length) fail(tree, ts.flattenDiagnosticMessageText(diagnostics[0].messageText, '\n'))
      cache.set(file, tree)
    }
    return cache.get(file)!
  }
  const inUI = (file: string) => file.startsWith(ui + '/')
  const browser = (file: string) => inUI(file) && relative(ui, file).split('/').slice(0, -1).some(part => part.startsWith('-'))
  const all = files(ui)
  for (const file of all) {
    const source = relative(root, file), local = relative(ui, file)
    if (extname(file) === '.tsx' && !browser(file)) fail(read(file), '.tsx must be inside a - directory')
    if (local.split('/').some(part => part.startsWith('-'))) continue
    const tree = read(file)
    if (extname(file) !== '.ts') fail(tree, 'Unclassified UI source extension')
    const bindings = namedBindings(tree)
    const exported = tree.statements.find(ts.isExportAssignment), call = exported?.expression
    const expected = local === 'nav.ts' ? ['defineNav'] : local === 'keys.ts' ? ['defineKeys'] : helpers
    if (!call || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) fail(exported ?? tree, 'Default export must directly call a named SDK helper')
    const binding = bindings.get(call.expression.text)
    const helper = expected.find(name => sdkBinding(binding, file, name, sdk, sdkFile))
    if (!helper || exported!.isExportEquals) fail(call, 'Default export must directly call a named SDK helper')
    let path: string | undefined
    if (!['nav.ts', 'keys.ts'].includes(local)) try { path = routePath(source) } catch (error) { fail(call, String(error)) }
    entries.push({ file, source, location: location(call), helper, ...(path !== undefined ? { path } : {}) })
  }
  const slots = resolve(ui, '-slots.ts')
  if (all.includes(slots)) {
    const tree = read(slots), exported = tree.statements.find(ts.isExportAssignment), call = exported?.expression
    if (!call || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || exported!.isExportEquals
      || !sdkBinding(namedBindings(tree).get(call.expression.text), slots, 'defineSlots', sdk, sdkFile)) fail(exported ?? tree, 'Slots must directly call a named SDK defineSlots import')
    entries.push({ file: slots, source: 'ui/-slots.ts', location: location(call), helper: 'defineSlots' })
  }
  const seen = new Set<string>()
  function inspect(file: string, allowComponent: boolean, isBrowser = false) {
    const key = `${file}:${allowComponent}:${isBrowser}`
    if (seen.has(key)) return
    seen.add(key)
    const tree = read(file)
    function edge(node: ts.Node, id: string, typeOnly: boolean) {
      if (id === sdk) return
      if (id === sdk + '/react' && (allowComponent || isBrowser)) return
      if (!id.startsWith('.')) {
        if (isBrowser && ts.resolveModuleName(id, file, { moduleResolution: ts.ModuleResolutionKind.Bundler }, ts.sys).resolvedModule) return
        fail(node, `Unresolved or unclassified package import: ${id}`)
      }
      const target = resolve(dirname(file), id)
      const candidates = (extname(target) ? [target] : [target, ...['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.mts', '.json'].map(ext => target + ext)]).filter(path => { try { return statSync(path).isFile() } catch { return false } })
      if (candidates.length !== 1) fail(node, `Unresolved or ambiguous import: ${id}`)
      const resolved = realpathSync(candidates[0])
      if (typeOnly) {
        if (resolved.startsWith(resolve(root, 'schema') + '/') && resolved.endsWith('.ts') || inUI(resolved) && resolved.endsWith('.ts')) return
        fail(node, `Unclassified type import: ${id}`)
      }
      if (!inUI(resolved)) fail(node, `Value import outside ui (config/schema/access prohibited): ${id}`)
      if (browser(resolved)) {
        if (!allowComponent && !isBrowser) fail(node, `Data page cannot import a component: ${id}`)
        if (!/\.[cm]?[jt]sx?$/.test(resolved)) fail(node, `Unclassified component: ${id}`)
        components.add(resolved)
        inspect(resolved, true, true)
      } else {
        if (!resolved.endsWith('.ts') || resolved.endsWith('.d.ts')) fail(node, `Unclassified data extension: ${id}`)
        inspect(resolved, false)
      }
    }
    function visit(node: ts.Node) {
      if (ts.isImportTypeNode(node)) {
        if (!ts.isLiteralTypeNode(node.argument) || !ts.isStringLiteral(node.argument.literal)) fail(node, 'Unclassified type import')
        edge(node, node.argument.literal.text, true)
      }
      if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) fail(node, 'Unclassified import.meta (including glob) is prohibited')
      if (ts.isImportEqualsDeclaration(node)) fail(node, 'import = require is unclassified')
      if (ts.isExportDeclaration(node) && node.moduleSpecifier) fail(node, 'Re-exports are unclassified')
      if (ts.isImportDeclaration(node)) {
        if (!ts.isStringLiteral(node.moduleSpecifier) || !node.importClause || node.attributes) fail(node, 'Side-effect or unclassified import')
        const clause = node.importClause, names = clause.namedBindings
        // Inline type specifiers can emit a side-effect import (verbatimModuleSyntax).
        const typeOnly = clause.isTypeOnly
        if (!typeOnly && node.moduleSpecifier.text === sdk) {
          if (clause.name || !names || !ts.isNamedImports(names)) fail(node, 'Expected named SDK imports')
          for (const item of names.elements) if (!item.isTypeOnly && ![...helpers, 'defineNav', 'defineSlots', 'defineKeys', 'col', 'param', 'one', 'list', 'p', 'layout', 'slot', 'action', 'link', 'buildPath', 'parseParams'].includes((item.propertyName ?? item.name).text)) fail(item, `${(item.propertyName ?? item.name).text} is not in slice 7`)
        }
        if (!typeOnly && node.moduleSpecifier.text === sdk + '/react' && !isBrowser) {
          if (!allowComponent || clause.name || !names || !ts.isNamedImports(names) || names.elements.some(item => !item.isTypeOnly && (item.propertyName ?? item.name).text !== 'AccessCard')) fail(node, 'Only the SDK AccessCard is allowed as a registered component')
        }
        edge(node.moduleSpecifier, node.moduleSpecifier.text, typeOnly)
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || /^(?:require|eval|Function)$/.test(node.expression.getText(tree)))) fail(node, 'Dynamic imports and unclassified evaluation are prohibited')
      if (ts.isCallExpression(node) && /^(?:query)$/.test(node.expression.getText(tree))) fail(node, `${node.expression.getText(tree)} is not in slice 7`)
      ts.forEachChild(node, visit)
    }
    visit(tree)
  }
  for (const entry of entries) inspect(entry.file, ['customPage', 'defineSlots'].includes(entry.helper))
  const result = { root, entries: entries.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0)), components, modules: new Map([...cache].map(([file, tree]) => [file, tree.text])) }
  checked.add(result)
  return result
}
