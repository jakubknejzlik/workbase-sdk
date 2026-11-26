import ts from 'typescript'
import { runtimeChangeSchema, setInteractiveSchema, fail, WorkflowError, type CompositionChange } from '../schemas.ts'
import { importOrder, permissionOptions, pluginOrder, pluginRegistry, parsePluginOptions, type CompositionConfig, type PluginName, type RuntimePlugin } from './registry.ts'

export interface RuntimeModel { interactive?: boolean; plugins: RuntimePlugin[] }
interface Binding { local: string; plugin?: PluginName; singleton?: boolean; node: ts.ImportSpecifier | ts.Identifier }
interface Parsed { file: ts.SourceFile; object: ts.ObjectLiteralExpression; config: string; bindings: Binding[]; model: RuntimeModel }
// transpileModule does not diagnose strict-mode/module binding early errors.
const reservedBindings = new Set([
  'eval', 'arguments', 'await', 'yield', 'let', 'implements', 'interface', 'package', 'private', 'protected', 'public', 'static',
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends',
  'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this',
  'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with',
])
function reject(node: ts.Node, message: string): never {
  const file = node.getSourceFile()
  const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file))
  throw new WorkflowError('runtime_not_canonical', `${file.fileName}:${line + 1}:${character + 1}: ${message}. Custom plugins and commands require a reviewed source change.`, 400,
    { file: file.fileName, line: line + 1, column: character + 1 })
}
function key(node: ts.PropertyName): string {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text
  return reject(node, 'Expected a literal property name')
}
/** This interpreter never executes expressions or imports from consumer source. */
function literal(node: ts.Expression): unknown {
  if (ts.isStringLiteral(node)) return node.text
  if (ts.isNumericLiteral(node)) {
    const value = Number(node.text)
    if (Number.isFinite(value)) return value
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false
  if (node.kind === ts.SyntaxKind.NullKeyword) return null
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) {
    const value = -Number(node.operand.text)
    if (Number.isFinite(value)) return value
  }
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal)
  if (ts.isObjectLiteralExpression(node)) {
    const result: Record<string, unknown> = {}
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) reject(property, 'Expected JSON literal properties')
      const name = key(property.name)
      if (['__proto__', 'constructor', 'prototype'].includes(name) || Object.hasOwn(result, name)) reject(property, 'Duplicate or reserved literal property')
      result[name] = literal(property.initializer)
    }
    return result
  }
  return reject(node, 'Expected a JSON literal argument')
}
function options(plugin: PluginName, value: unknown, node: ts.Node): unknown {
  try { return parsePluginOptions(plugin, value) }
  catch { return reject(node, `Invalid options for ${plugin}`) }
}
function parse(source: string, filename: string): Parsed {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const diagnostics = ts.transpileModule(source, { fileName: filename, reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.Latest } }).diagnostics ?? []
  if (diagnostics.length) {
    const diagnostic = diagnostics[0]
    const { line, character } = file.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
    throw new WorkflowError('runtime_not_canonical', `${filename}:${line + 1}:${character + 1}: Invalid runtime syntax`, 400, { file: filename, line: line + 1, column: character + 1 })
  }
  const bindings: Binding[] = []
  const locals = new Set<string>()
  let object: ts.ObjectLiteralExpression | undefined
  let config: string | undefined
  function bind(binding: Binding) {
    const identifier = ts.isImportSpecifier(binding.node) ? binding.node.name : binding.node
    if (reservedBindings.has(identifier.text)) reject(identifier, 'Invalid module import binding')
    if (locals.has(binding.local)) reject(binding.node, 'Duplicate import binding')
    locals.add(binding.local); bindings.push(binding)
  }
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause
      if (!clause || clause.isTypeOnly || statement.attributes || !ts.isStringLiteral(statement.moduleSpecifier) || statement.modifiers?.length) reject(statement, 'Expected direct built-in imports')
      const module = statement.moduleSpecifier.text
      if (module === './config' || module === './config.ts') {
        if (!clause.name || clause.namedBindings || config) reject(statement, 'Expected one default config import')
        config = clause.name.text
        bind({ local: config, node: clause.name })
        continue
      }
      const plugin = importOrder.find(name => module === `@workbasehq/plugins/${name}`)
      if (!plugin || clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings) || !clause.namedBindings.elements.length) reject(statement, 'Unknown import or noncanonical import shape')
      const entry = pluginRegistry[plugin]
      for (const specifier of clause.namedBindings.elements) {
        const exported = (specifier.propertyName ?? specifier.name).text
        if (specifier.isTypeOnly || ![entry.factory, entry.singleton].includes(exported)) reject(specifier, 'Unknown built-in export')
        bind({ local: specifier.name.text, plugin, singleton: exported === entry.singleton, node: specifier })
      }
      continue
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals && ts.isObjectLiteralExpression(statement.expression) && !object) {
      object = statement.expression
      continue
    }
    reject(statement, 'Expected only imports and one default object export')
  }
  if (!object || !config) reject(file, 'Missing config import or default runtime object')
  const seen = new Set<string>()
  const model: RuntimeModel = { plugins: [] }
  let spread = false
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) {
      if (spread || seen.size || !ts.isIdentifier(property.expression) || property.expression.text !== config) reject(property, 'Only the initial config spread is supported')
      spread = true
      continue
    }
    if (!ts.isPropertyAssignment(property)) reject(property, 'Expected runtime literal properties')
    const name = key(property.name)
    if (!spread || seen.has(name)) reject(property, 'Missing initial config spread or duplicate property')
    seen.add(name)
    if (name === 'interactive') {
      const value = literal(property.initializer)
      if (typeof value !== 'boolean') reject(property, 'interactive must be a boolean literal')
      model.interactive = value
    } else if (name === 'plugins') {
      if (!ts.isArrayLiteralExpression(property.initializer)) reject(property, 'plugins must be an array literal')
      const plugins = new Set<PluginName>()
      for (const element of property.initializer.elements) {
        const call = ts.isCallExpression(element) ? element : undefined
        const nameNode = call ? call.expression : element
        if (!ts.isIdentifier(nameNode)) reject(element, 'Expected a built-in factory or compatibility singleton')
        const binding = bindings.find(item => item.local === nameNode.text)
        if (!binding?.plugin) reject(element, 'Plugin must reference a known built-in import')
        if (plugins.has(binding.plugin)) reject(element, 'Duplicate plugin')
        plugins.add(binding.plugin)
        if (call ? binding.singleton || call.arguments.length > 1 || call.typeArguments || call.questionDotToken : !binding.singleton) reject(element, 'Expected a direct factory call or compatibility singleton')
        const parsed = options(binding.plugin, call?.arguments.length ? literal(call.arguments[0]) : undefined, element)
        model.plugins.push({ plugin: binding.plugin, ...(parsed === undefined ? {} : { options: parsed }) })
      }
    } else reject(property, 'Unknown runtime property')
  }
  if (!spread || !seen.has('plugins')) reject(object, 'Expected config spread and plugins array')
  model.plugins.sort((a, b) => pluginOrder.indexOf(a.plugin) - pluginOrder.indexOf(b.plugin))
  return { file, object, config, bindings, model }
}
export function parseRuntimeSource(source: string, filename = 'runtime.ts'): RuntimeModel {
  return parse(source, filename).model
}
function normalize(model: RuntimeModel, config: CompositionConfig): RuntimeModel {
  // Validate programmatic models through the same closed boundary as authored sources.
  const seen = new Set<PluginName>()
  const plugins = model.plugins.map(({ plugin, options: value }) => {
    if (!Object.hasOwn(pluginRegistry, plugin) || seen.has(plugin)) fail('runtime_not_canonical', 'Unknown or duplicate runtime plugin')
    seen.add(plugin)
    const parsed = parsePluginOptions(plugin, plugin === 'permissions' ? permissionOptions(config) : value)
    return { plugin, ...(parsed === undefined ? {} : { options: parsed }) }
  }).sort((a, b) => pluginOrder.indexOf(a.plugin) - pluginOrder.indexOf(b.plugin))
  if (model.interactive !== undefined && typeof model.interactive !== 'boolean') fail('runtime_not_canonical', 'interactive must be a boolean')
  return { ...(model.interactive === undefined ? {} : { interactive: model.interactive }), plugins }
}
export function applyRuntimeChanges(model: RuntimeModel, changes: readonly CompositionChange[], config: CompositionConfig): RuntimeModel {
  const next = structuredClone(model)
  for (const raw of changes) {
    const change = runtimeChangeSchema.parse(raw)
    if (change.kind === 'set_interactive') next.interactive = change.interactive
    else {
      const entry: RuntimePlugin = { plugin: change.plugin, ...('options' in change && change.options !== undefined ? { options: change.options } : {}) }
      const index = next.plugins.findIndex(plugin => plugin.plugin === change.plugin)
      if (index < 0) next.plugins.push(entry)
      else next.plugins[index] = entry
    }
  }
  return normalize(next, config)
}
/** Derive source from caller-supplied base data without hydrating runtime plugins. */
export function deriveInteractiveSource(source: string, change: unknown, config: CompositionConfig) {
  const parsedChange = setInteractiveSchema.parse(change)
  const model = applyRuntimeChanges(parseRuntimeSource(source), [parsedChange], config)
  const data = rewriteRuntimeSource(source, model, config)
  return { model, files: [{ path: 'runtime.ts', data }] }
}
function text(value: unknown): string {
  if (typeof value === 'string') return "'" + value.replace(/['\\\u0000-\u001f\u2028\u2029]/g, character => character === "'" ? "\\'" : character === '\u2028' ? '\\u2028' : character === '\u2029' ? '\\u2029' : JSON.stringify(character).slice(1, -1)) + "'"
  if (Array.isArray(value)) return `[${value.map(text).join(', ')}]`
  if (value && typeof value === 'object') return `{ ${Object.entries(value).map(([name, child]) => `${/^[a-zA-Z_$][\w$]*$/.test(name) ? name : text(name)}: ${text(child)}`).join(', ')} }`
  return JSON.stringify(value)
}
function objectSource(model: RuntimeModel, config: string, names: Map<PluginName, string>): string {
  const rows = [pluginOrder.slice(0, 2), pluginOrder.slice(2, 5), pluginOrder.slice(5)]
    .map(row => row.flatMap(name => {
      const plugin = model.plugins.find(item => item.plugin === name)
      return plugin ? [`${names.get(name)}(${plugin.options === undefined ? '' : text(plugin.options)})`] : []
    })).filter(row => row.length).map(row => `  ${row.join(', ')},`)
  return `{ ...${config}, ${model.interactive === undefined ? '' : `interactive: ${model.interactive}, `}plugins: [\n${rows.join('\n')}${rows.length ? '\n' : ''}] }`
}
export function printRuntimeSource(model: RuntimeModel, config: CompositionConfig): string {
  const normalized = normalize(model, config)
  const used = new Set(normalized.plugins.map(plugin => plugin.plugin))
  const names = new Map(importOrder.map(name => [name, pluginRegistry[name].factory]))
  const imports = importOrder.filter(name => used.has(name)).map(name => `import { ${names.get(name)} } from '@workbasehq/plugins/${name}'\n`).join('')
  return `${imports}import config from './config'\n\n// Executable plugin composition stays outside the literal config loader boundary.\nexport default ${objectSource(normalized, 'config', names)}\n`
}
/** Role-only authoring changes the derived provider options, preserving the
 * surrounding runtime expression, imports, comments and factory choices. */
export function rewritePermissionsSource(source: string, config: CompositionConfig): string {
  const parsed = parse(source, 'runtime.ts')
  const plugins = parsed.object.properties.find(property => ts.isPropertyAssignment(property)
    && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === 'plugins') as ts.PropertyAssignment
  const call = (plugins.initializer as ts.ArrayLiteralExpression).elements.find(element => ts.isCallExpression(element)
    && ts.isIdentifier(element.expression) && parsed.bindings.some(binding => binding.local === element.expression.getText(parsed.file) && binding.plugin === 'permissions')) as ts.CallExpression | undefined
  if (!call) return source
  const start = call.arguments.length ? call.arguments[0].getStart(parsed.file) : call.end - 1
  const end = call.arguments.length ? call.arguments[0].end : start
  return source.slice(0, start) + text(permissionOptions(config)) + source.slice(end)
}
/** Preserve all authored bytes outside the object and the necessary import edits. */
export function rewriteRuntimeSource(source: string, model: RuntimeModel, config: CompositionConfig, filename = 'runtime.ts'): string {
  const parsed = parse(source, filename)
  const normalized = normalize(model, config)
  const names = new Map<PluginName, string>()
  const edits: { start: number; end: number; text: string }[] = []
  const locals = new Set(parsed.bindings.map(binding => binding.local))
  const additions: string[] = []
  for (const plugin of importOrder.filter(name => normalized.plugins.some(plugin => plugin.plugin === name))) {
    const entry = pluginRegistry[plugin]
    const binding = parsed.bindings.find(item => item.plugin === plugin && !item.singleton) ?? parsed.bindings.find(item => item.plugin === plugin)
    if (binding) {
      names.set(plugin, binding.local)
      if (binding.singleton && ts.isImportSpecifier(binding.node)) {
        const imported = binding.node.propertyName ?? binding.node.name
        // Splice only the imported token; retain every comment, alias and separator.
        const start = imported.getStart(parsed.file)
        const quoted = ts.isStringLiteral(imported)
        edits.push({
          start: start + (quoted ? 1 : 0), end: imported.end - (quoted ? 1 : 0),
          text: binding.node.propertyName ? entry.factory : `${entry.factory} as ${source.slice(start, imported.end)}`,
        })
      }
    } else {
      let local = entry.factory
      for (let i = 2; locals.has(local); i++) local = `${entry.factory}${i}`
      locals.add(local); names.set(plugin, local)
      additions.push(`import { ${entry.factory}${local === entry.factory ? '' : ` as ${local}`} } from '@workbasehq/plugins/${plugin}'\n`)
    }
  }
  if (additions.length) {
    // Insert before the first statement, leaving all existing imports and comments intact.
    const start = parsed.file.statements[0].getStart(parsed.file)
    edits.push({ start, end: start, text: additions.join('') })
  }
  edits.push({ start: parsed.object.getStart(parsed.file), end: parsed.object.end, text: objectSource(normalized, parsed.config, names) })
  return edits.sort((a, b) => b.start - a.start).reduce((result, edit) => result.slice(0, edit.start) + edit.text + result.slice(edit.end), source)
}
