/** Build-time source validation only: keep Node and the TS compiler out of runtime imports. */
import { readFileSync, realpathSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import ts from 'typescript'
import { accountLink, DeclarationError, defineConfig, defineEntity } from '../schema'
import type { InstanceConfig } from '../config'

export interface SourceLocation { file: string; line: number; column: number }
export type SourceMap = Record<string, SourceLocation>
export class SourceError extends Error {
  constructor(readonly location: SourceLocation, message: string) {
    super(`${location.file}:${location.line}:${location.column}: ${message}`)
    this.name = 'SourceError'
  }
}
function location(node: ts.Node): SourceLocation {
  const file = node.getSourceFile()
  const pos = file.getLineAndCharacterOfPosition(node.getStart(file))
  return { file: file.fileName, line: pos.line + 1, column: pos.character + 1 }
}
function fail(node: ts.Node, message: string): never { throw new SourceError(location(node), message) }
function read(file: string) {
  const text = readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  // Syntax errors the host would reject must never yield an interpreted config.
  const [diagnostic] = ts.transpileModule(text, { fileName: file, reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.Latest } }).diagnostics ?? []
  if (diagnostic) {
    const pos = diagnostic.start === undefined ? { line: 0, character: 0 } : source.getLineAndCharacterOfPosition(diagnostic.start)
    throw new SourceError({ file, line: pos.line + 1, column: pos.character + 1 }, ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
  }
  return source
}
function unwrap(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node) ? unwrap(node.expression) : node
}
function key(node: ts.PropertyName): string {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text
  return fail(node, 'Computed property names are outside the literal boundary')
}
function properties(node: ts.ObjectLiteralExpression) {
  const entries = new Map<string, ts.ObjectLiteralElementLike>()
  for (const property of node.properties) {
    if (!property.name) fail(property, 'Spread is outside the literal boundary')
    const name = key(property.name)
    if (name === '__proto__') fail(property, '__proto__ is outside the literal boundary')
    if (entries.has(name)) fail(property, `Duplicate literal property: ${name}`)
    entries.set(name, property)
  }
  return entries
}
function value(node: ts.ObjectLiteralElementLike | undefined): ts.Expression | undefined {
  if (!node) return undefined
  if (ts.isPropertyAssignment(node)) return unwrap(node.initializer)
  if (ts.isShorthandPropertyAssignment(node)) return node.name
  return fail(node, 'Expected a property assignment')
}
interface Binding { module: string; imported: string; node: ts.StringLiteral }
function imports(file: ts.SourceFile, statements: readonly ts.Statement[] = file.statements) {
  const bindings = new Map<string, Binding>()
  const add = (name: string, binding: Binding) => {
    if (bindings.has(name)) fail(binding.node, `Duplicate import binding: ${name}`)
    bindings.set(name, binding)
  }
  for (const statement of statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.isTypeOnly) continue
    const clause = statement.importClause
    if (clause?.name) add(clause.name.text, { node: statement.moduleSpecifier, module: statement.moduleSpecifier.text, imported: 'default' })
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const item of clause.namedBindings.elements) {
      if (!item.isTypeOnly) add(item.name.text, { node: statement.moduleSpecifier, module: statement.moduleSpecifier.text, imported: (item.propertyName ?? item.name).text })
    }
  }
  return bindings
}
/** Bare SDK imports are syntax; local SDK imports must identify the canonical file. */
function sdkBinding(binding: Binding | undefined, file: string, name: string) {
  if (binding?.imported !== name) return false
  if (binding.module === '@workbasehq/core/schema') return true
  if (!binding.module.startsWith('./') && !binding.module.startsWith('../') && !isAbsolute(binding.module)) return false
  const path = resolve(dirname(file), binding.module)
  const candidates = extname(path) ? [path] : [path, `${path}.ts`]
  const files: string[] = []
  try {
    for (const candidate of candidates) {
      try {
        // Direct files only: directories never imply an index or package lookup.
        if (statSync(candidate).isFile()) files.push(realpathSync(candidate))
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      }
    }
    if (files.length > 1) fail(binding.node, `Ambiguous SDK import: ${binding.module}`)
    if (!files.length) fail(binding.node, `Cannot resolve SDK import: ${binding.module}`)
    return files[0] === realpathSync(fileURLToPath(new URL('../schema.ts', import.meta.url)))
  } catch (error) {
    if (error instanceof SourceError) throw error
    return fail(binding.node, `Cannot resolve SDK import: ${binding.module}`)
  }
}
/** Entity resolution is deliberately independent of host extension/index precedence. */
function entityPath(binding: Binding, entry: string, name: string): string {
  if (![`./schema/${name}`, `./schema/${name}.ts`].includes(binding.module) || /[/\\]/.test(name)) fail(binding.node, 'Entity import must match schema/<entity>.ts')
  try {
    const schema = realpathSync(resolve(dirname(entry), 'schema'))
    // Reject every competing sibling, including an extensionless file or directory.
    const lower = name.toLowerCase()
    if (readdirSync(schema).some(candidate => candidate !== `${name}.ts`
      && (candidate.toLowerCase() === lower || candidate.toLowerCase().startsWith(lower + '.')))) fail(binding.node, 'Ambiguous entity import: competing schema candidate')
    const path = realpathSync(resolve(schema, `${name}.ts`))
    if (dirname(path) !== schema) fail(binding.node, 'Resolved entity import must match schema/<entity>.ts inside the schema directory')
    return path
  } catch (error) {
    if (error instanceof SourceError) throw error
    return fail(binding.node, 'Cannot resolve entity import')
  }
}
/** Only these statements and imports belong to the declaration syntax. */
function moduleBoundary(file: ts.SourceFile, declaration: ts.Expression, helpers: string[], entityImports = new Set<string>()) {
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause
      if (!clause || !ts.isStringLiteral(statement.moduleSpecifier) || statement.attributes) fail(statement, 'Expected a direct named SDK or entity import')
      if (clause.isTypeOnly) continue
      if (!clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
        && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every(item => item.isTypeOnly)) continue
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) fail(statement, 'Expected direct named imports')
      const names = [...imports(file, [statement]).entries()]
      if (!names.length) fail(statement, 'Expected a direct named SDK or entity import')
      for (const [local, binding] of names) {
        if (entityImports.has(local)) continue
        if (!helpers.some(name => sdkBinding(binding, file.fileName, name))) fail(statement, 'Expected a direct named SDK or entity import')
      }
      continue
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals && unwrap(statement.expression) === declaration) continue
    if (ts.isVariableStatement(statement) && statement.modifiers?.length === 1 && statement.modifiers[0].kind === ts.SyntaxKind.ExportKeyword
      && statement.declarationList.flags === ts.NodeFlags.Const && statement.declarationList.declarations.length === 1
      && statement.declarationList.declarations[0].initializer && unwrap(statement.declarationList.declarations[0].initializer!) === declaration) continue
    fail(statement, 'Expected only imports and one direct declaration export')
  }
}
function exported(file: ts.SourceFile, name: string): ts.Expression | undefined {
  if (name === 'default') {
    const statement = file.statements.find(ts.isExportAssignment)
    if (statement && !statement.isExportEquals) return unwrap(statement.expression)
  }
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement) || !statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue
    for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) return unwrap(declaration.initializer)
  }
}
function index(node: ts.Expression, path: string, sources: SourceMap) {
  node = unwrap(node)
  sources[path] = location(node)
  if (ts.isObjectLiteralExpression(node)) for (const [name, property] of properties(node)) {
    const child = [path, name].filter(Boolean).join('.')
    const expression = value(property)
    if (expression) index(expression, child, sources)
    sources[child] = location(property)
  }
  if (ts.isArrayLiteralExpression(node)) node.elements.forEach((element, i) => index(element, `${path}.${i}`, sources))
}
function nearest(sources: SourceMap, path: string): SourceLocation {
  while (!sources[path] && path) path = path.split('.').slice(0, -1).join('.')
  return sources[path] ?? sources['']
}
function remap(error: unknown, sources: SourceMap, prefix = ''): never {
  if (error instanceof SourceError) throw error
  if (error instanceof DeclarationError) throw new SourceError(nearest(sources, [prefix, ...error.path].filter(part => part !== '').join('.')), error.message)
  throw new SourceError(nearest(sources, prefix), error instanceof Error ? error.message : String(error))
}
/** Evaluate only literal syntax already accepted by the boundary, never JavaScript code. */
function literal(node: ts.Expression, bindings: Map<string, Binding>, path: string[] = []): unknown {
  node = unwrap(node)
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isNumericLiteral(node)) return Number(node.text)
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false
  if (node.kind === ts.SyntaxKind.NullKeyword) return null
  if (ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.MinusToken, ts.SyntaxKind.PlusToken].includes(node.operator) && ts.isNumericLiteral(node.operand)) return (node.operator === ts.SyntaxKind.MinusToken ? -1 : 1) * Number(node.operand.text)
  if (ts.isArrayLiteralExpression(node)) return node.elements.map((element, i) => literal(element, bindings, [...path, String(i)]))
  if (ts.isObjectLiteralExpression(node)) {
    // Plain objects, as JavaScript evaluation of the same literal would produce.
    const result: Record<string, unknown> = {}
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) fail(property, 'Spread is outside the literal boundary')
      if (!ts.isPropertyAssignment(property)) fail(property, 'Expected a literal property assignment; no variables, methods or accessors')
      const name = key(property.name)
      if (name === '__proto__') fail(property, '__proto__ is outside the literal boundary')
      if (Object.hasOwn(result, name)) fail(property, `Duplicate literal property: ${name}`)
      result[name] = literal(property.initializer, bindings, [...path, name])
    }
    return result
  }
  if (ts.isCallExpression(node)) {
    if (path.join('.') === 'fields.user' && ts.isIdentifier(node.expression)
      && sdkBinding(bindings.get(node.expression.text), node.getSourceFile().fileName, 'accountLink') && !node.arguments.length && !node.typeArguments?.length) return accountLink()
    return fail(node, 'Function call is outside the literal boundary; only SDK accountLink() at fields.user is allowed')
  }
  return fail(node, 'Expected a literal value; variables and expressions are outside the literal boundary')
}

/**
 * Interpret literal declarations and return the one kernel schema without executing
 * consumer modules or asking the host runtime to resolve their imports.
 * config.ts must default-export defineConfig({...}); its entity map explicitly imports
 * default or named defineEntity({...}) exports from schema/<entity>.ts.
 * Legacy defineInstance remains available through its existing runtime entry.
 */
export async function loadConfig(file: string): Promise<{ config: InstanceConfig; sources: SourceMap }> {
  const entry = realpathSync(resolve(file))
  const source = read(entry)
  const sources: SourceMap = { '': location(source) }
  const bindings = imports(source)
  const declaration = exported(source, 'default')
  if (!declaration || !ts.isCallExpression(declaration) || !ts.isIdentifier(declaration.expression)) fail(source, 'Config must default-export a direct SDK defineConfig({...}) call')
  if (!sdkBinding(bindings.get(declaration.expression.text), entry, 'defineConfig')) fail(declaration, 'Expected a direct named SDK defineConfig import')
  const arg = declaration.arguments[0]
  if (declaration.arguments.length !== 1 || !arg || !ts.isObjectLiteralExpression(unwrap(arg))) fail(declaration, 'defineConfig requires a literal object')
  const config = unwrap(arg) as ts.ObjectLiteralExpression
  index(config, '', sources)
  const props = properties(config)
  const entityMap = value(props.get('entities'))
  if (!entityMap || !ts.isObjectLiteralExpression(entityMap)) fail(entityMap ?? config, 'entities must explicitly import schema/<entity>.ts declarations')
  const entityImports = new Set<string>()
  for (const property of properties(entityMap).values()) {
    const ref = value(property)
    if (!ref || !ts.isIdentifier(ref)) fail(ref ?? property, 'Entity must be an explicit schema import')
    entityImports.add(ref.text)
  }
  moduleBoundary(source, declaration, ['defineConfig'], entityImports)
  const data: Record<string, unknown> = Object.create(null)
  for (const [name, property] of props) if (name !== 'entities') data[name] = literal(value(property)!, new Map())
  const entities: Record<string, ReturnType<typeof defineEntity>> = Object.create(null)
  for (const [name, property] of properties(entityMap)) {
    if (name === 'users') fail(property, 'users is SDK-owned; use accountLink()')
    const ref = value(property) as ts.Identifier
    const binding = bindings.get(ref.text)
    if (!binding?.module.startsWith('./schema/')) fail(ref, 'Entity must be imported from schema/<entity>.ts')
    if (![`./schema/${name}`, `./schema/${name}.ts`].includes(binding.module)) fail(ref, 'Entity import must match schema/<entity>.ts')
    const path = entityPath(binding, entry, name)
    const entitySource = read(path)
    const entityBindings = imports(entitySource)
    const expression = exported(entitySource, binding.imported)
    if (!expression || !ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)
      || !sdkBinding(entityBindings.get(expression.expression.text), path, 'defineEntity')) fail(entitySource, 'Expected an exported defineEntity({...}) declaration')
    const entity = expression.arguments[0]
    if (expression.arguments.length !== 1 || !entity || !ts.isObjectLiteralExpression(unwrap(entity))) fail(expression, 'defineEntity requires a literal object')
    const prefix = `entities.${name}`
    const entityData = literal(entity, entityBindings)
    moduleBoundary(entitySource, expression, ['defineEntity', 'accountLink'])
    index(unwrap(entity), prefix, sources)
    try { entities[name] = defineEntity(entityData as Parameters<typeof defineEntity>[0]) } catch (error) { remap(error, sources, prefix) }
  }
  try {
    const config = defineConfig({ ...data, entities } as Parameters<typeof defineConfig>[0])
    return { config, sources }
  } catch (error) { return remap(error, sources) }
}
