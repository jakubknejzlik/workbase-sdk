/** Build-time source validation only: keep Node and the TS compiler out of runtime imports. */
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath, URL } from 'node:url'
import ts from 'typescript'
import { accountLink, DeclarationError, defineEntity, isSchemaConfig } from '../schema'
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
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
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
    entries.set(key(property.name), property)
  }
  return entries
}
function value(node: ts.ObjectLiteralElementLike | undefined): ts.Expression | undefined {
  if (!node) return undefined
  if (ts.isPropertyAssignment(node)) return unwrap(node.initializer)
  if (ts.isShorthandPropertyAssignment(node)) return node.name
  return fail(node, 'Expected a property assignment')
}
interface Binding { module: string; imported: string }
function imports(file: ts.SourceFile) {
  const bindings = new Map<string, Binding>()
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.isTypeOnly) continue
    const clause = statement.importClause
    if (clause?.name) bindings.set(clause.name.text, { module: statement.moduleSpecifier.text, imported: 'default' })
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const item of clause.namedBindings.elements) {
      if (!item.isTypeOnly) bindings.set(item.name.text, { module: statement.moduleSpecifier.text, imported: (item.propertyName ?? item.name).text })
    }
  }
  return bindings
}
function sdkBinding(binding: Binding | undefined, file: string, name: string) {
  if (binding?.imported !== name) return false
  return binding.module === '@workbasehq/core/schema' || (binding.module.startsWith('.') || binding.module.startsWith('/'))
    && resolve(dirname(file), binding.module) === fileURLToPath(new URL('../schema.ts', import.meta.url))
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
  sources[path] = location(node)
  if (ts.isObjectLiteralExpression(node)) for (const [name, property] of properties(node)) {
    const expression = value(property)
    sources[[path, name].filter(Boolean).join('.')] = location(property)
    if (expression && ts.isObjectLiteralExpression(expression)) {
      index(expression, [path, name].filter(Boolean).join('.'), sources)
      sources[[path, name].filter(Boolean).join('.')] = location(property)
    }
  }
  if (ts.isArrayLiteralExpression(node)) node.elements.forEach((element, i) => { sources[`${path}.${i}`] = location(element) })
}
function nearest(sources: SourceMap, path: string): SourceLocation {
  while (!sources[path] && path) path = path.split('.').slice(0, -1).join('.')
  return sources[path] ?? sources['']
}
function remap(error: unknown, sources: SourceMap, prefix = ''): never {
  if (error instanceof SourceError) throw error
  if (error instanceof DeclarationError) throw new SourceError(nearest(sources, [prefix, ...error.path].filter(Boolean).join('.')), error.message)
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
    const result: Record<string, unknown> = Object.create(null)
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) fail(property, 'Spread is outside the literal boundary')
      if (!ts.isPropertyAssignment(property)) fail(property, 'Expected a literal property assignment; no variables, methods or accessors')
      const name = key(property.name)
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
 * Validate the new-era source before importing it, then return the one kernel schema.
 * config.ts must default-export defineConfig({...}); its entity map explicitly imports
 * default or named defineEntity({...}) exports from schema/<entity>.ts.
 * Legacy defineInstance modules remain importable with their existing normalization.
 * Use the host TS runner (Bun or tsx), as with the existing infra config loader.
 */
export async function loadConfig(file: string): Promise<{ config: InstanceConfig; sources: SourceMap }> {
  const entry = realpathSync(resolve(file))
  const source = read(entry)
  const sources: SourceMap = { '': location(source) }
  const bindings = imports(source)
  const declaration = exported(source, 'default')
  const newEra = declaration && ts.isCallExpression(declaration) && ts.isIdentifier(declaration.expression)
    && sdkBinding(bindings.get(declaration.expression.text), entry, 'defineConfig')
  if (newEra) {
    const arg = declaration.arguments[0]
    if (declaration.arguments.length !== 1 || !arg || !ts.isObjectLiteralExpression(unwrap(arg))) fail(declaration, 'defineConfig requires a literal object')
    const config = unwrap(arg) as ts.ObjectLiteralExpression
    index(config, '', sources)
    const props = properties(config)
    const entityMap = value(props.get('entities'))
    if (!entityMap || !ts.isObjectLiteralExpression(entityMap)) fail(entityMap ?? config, 'entities must explicitly import schema/<entity>.ts declarations')
    for (const [name, property] of properties(entityMap)) {
      if (name === 'users') fail(property, 'users is SDK-owned; use accountLink()')
      const ref = value(property)
      if (!ref || !ts.isIdentifier(ref)) fail(ref ?? property, 'Entity must be an explicit schema import')
      const binding = bindings.get(ref.text)
      if (!binding?.module.startsWith('./schema/')) fail(ref, 'Entity must be imported from schema/<entity>.ts')
      const path = resolve(dirname(entry), binding.module.replace(/\.ts$/, '') + '.ts')
      if (path !== resolve(dirname(entry), `schema/${name}.ts`)) fail(ref, 'Entity import must match schema/<entity>.ts')
      const entitySource = read(path)
      const expression = exported(entitySource, binding.imported)
      if (!expression || !ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)
        || !sdkBinding(imports(entitySource).get(expression.expression.text), path, 'defineEntity')) fail(entitySource, 'Expected an exported defineEntity({...}) declaration')
      const entity = expression.arguments[0]
      if (expression.arguments.length !== 1 || !entity || !ts.isObjectLiteralExpression(unwrap(entity))) fail(expression, 'defineEntity requires a literal object')
      const prefix = `entities.${name}`
      // Check the boundary before indexing: indexing must never hide a spread/accessor.
      const data = literal(entity, imports(entitySource))
      index(unwrap(entity), prefix, sources)
      try { defineEntity(data as Parameters<typeof defineEntity>[0]) } catch (error) { remap(error, sources, prefix) }
    }
  }
  try {
    const config: unknown = (await import(pathToFileURL(entry).href)).default
    if (newEra && !isSchemaConfig(config)) fail(source, 'Expected a defineConfig result')
    if (!newEra && isSchemaConfig(config)) fail(source, 'New-era config must default-export defineConfig({...}) with explicit schema imports')
    if (!config || typeof config !== 'object' || !('entities' in config) || !('roles' in config)) fail(source, 'Expected an instance config default export')
    return { config: config as InstanceConfig, sources }
  } catch (error) { return remap(error, sources) }
}
