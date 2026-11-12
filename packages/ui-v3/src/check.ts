import { readdir, readFile } from 'node:fs/promises'
import { resolve, relative, dirname, extname } from 'node:path'
import ts from 'typescript'

export async function uiFiles(root: string): Promise<string[]> {
  async function walk(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true })
    return (await Promise.all(entries.map(entry => entry.isDirectory() ? walk(resolve(dir, entry.name)) : [resolve(dir, entry.name)]))).flat()
  }
  return (await walk(resolve(root, 'ui'))).sort()
}
export const isRoute = (root: string, file: string) => relative(resolve(root, 'ui'), file).split('/').every(part => !part.startsWith('-')) && file.endsWith('.ts') && relative(resolve(root, 'ui'), file) !== 'nav.ts'

// Syntax is inspected only for CI import boundaries. Manifest extraction never parses an AST.
export async function checkSources(root: string) {
  const files = await uiFiles(root)
  const errors: string[] = []
  const sourceCache = new Map<string, ts.SourceFile>()
  async function source(file: string) {
    if (!sourceCache.has(file)) sourceCache.set(file, ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true))
    return sourceCache.get(file)!
  }
  const options: ts.CompilerOptions = { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX }
  for (const file of files) {
    const local = relative(resolve(root, 'ui'), file)
    if (file.endsWith('.tsx') && !local.split('/').slice(0, -1).some(part => part.startsWith('-'))) errors.push(`${local}: .tsx must be inside a -prefixed directory`)
    if (!isRoute(root, file)) continue
    const tree = await source(file)
    let helper: string | undefined
    const helpers = new Map<string, string>()
    for (const statement of tree.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === '@workbasehq/ui-v3') {
      const bindings = statement.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) helpers.set(item.name.text, item.propertyName?.text ?? item.name.text)
    }
    for (const statement of tree.statements) if (ts.isExportAssignment(statement) && ts.isCallExpression(statement.expression) && ts.isIdentifier(statement.expression.expression)) helper = helpers.get(statement.expression.expression.text)
    if (!helper || !['page', 'entityListPage', 'entityDetailPage', 'entityCreatePage', 'entityEditPage', 'customPage'].includes(helper)) errors.push(`${local}: default export must call an SDK page helper`)
    const seen = new Set<string>()
    async function inspect(moduleFile: string, top: boolean) {
      if (seen.has(moduleFile)) return
      seen.add(moduleFile)
      const module = await source(moduleFile)
      const imports: { value: string; typeOnly: boolean }[] = []
      function visit(node: ts.Node) {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push({ value: node.moduleSpecifier.text, typeOnly: ts.isImportDeclaration(node) ? !!node.importClause?.isTypeOnly : node.isTypeOnly })
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
          const arg = node.arguments[0]
          if (!arg || !ts.isStringLiteral(arg)) errors.push(`${local}: nonliteral import cannot be audited`)
          else imports.push({ value: arg.text, typeOnly: false })
        }
        ts.forEachChild(node, visit)
      }
      visit(module)
      for (const item of imports) {
        const id = item.value
        if (helper !== 'customPage' && /^(react|react-dom)(\/|$)/.test(id)) errors.push(`${local}: data page must not import React (${relative(root, moduleFile)})`)
        if (id === '@workbasehq/ui-v3' || item.typeOnly) continue
        const resolved = ts.resolveModuleName(id, moduleFile, options, ts.sys).resolvedModule?.resolvedFileName
        if (helper === 'customPage' && top) {
          if (!resolved || !(extname(resolved) === '.tsx' || resolved.includes('/-components/'))) errors.push(`${local}: customPage may import components only: ${id}`)
          continue
        }
        if (helper !== 'customPage') {
          if (!resolved || !id.startsWith('.')) { errors.push(`${local}: data dependency must be an auditable local .ts module: ${id}`); continue }
          if (resolved.endsWith('.tsx') || resolved.includes('/-components/')) errors.push(`${local}: data page cannot import components: ${id}`)
          else if (resolved.endsWith('.ts')) await inspect(resolve(dirname(moduleFile), relative(dirname(moduleFile), resolved)), false)
        }
      }
    }
    await inspect(file, true)
  }
  if (errors.length) throw new Error(errors.join('\n'))
  return files.filter(file => isRoute(root, file))
}
