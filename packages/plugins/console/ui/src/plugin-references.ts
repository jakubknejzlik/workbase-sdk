import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { nodeSpan, type Reference, type ReferenceDiagnostic, type PluginContract } from '@workbasehq/core/references'

/** Read registered plugin metadata without executing runtime.ts or plugin hooks.
 * Dynamic/custom factories without literal metadata remain explicit coverage gaps. */
export function pluginReferences(root: string) {
  const references: Reference[] = [], contracts: PluginContract[] = [], uncovered: ReferenceDiagnostic[] = []
  const trees = new Map<string, ts.SourceFile>()
  const read = (file: string) => {
    if (!trees.has(file)) trees.set(file, ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true))
    return trees.get(file)!
  }
  const gap = (node: ts.Node, message: string) => uncovered.push({ code: 'opaque-plugin-reference', kind: 'plugin', source: nodeSpan(node), message,
    repairHint: 'Declare literal schemaReferences metadata on the plugin and review its executable dependencies.' })
  const unwrapped = (node: ts.Expression): ts.Expression => ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node) || ts.isTypeAssertionExpression(node) ? unwrapped(node.expression) : node
  const plainKey = (name: ts.PropertyName): string | undefined => ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined
  const property = (object: ts.ObjectLiteralExpression, key: string) => object.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && plainKey(p.name) === key)
  function symbol(tree: ts.SourceFile, name: string): ts.Expression | ts.FunctionDeclaration | undefined {
    for (const statement of tree.statements) {
      if (ts.isExportAssignment(statement) && name === 'default') return statement.expression
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement
      if (ts.isVariableStatement(statement)) for (const d of statement.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name) return d.initializer
    }
  }
  function inspect(node: ts.Expression | ts.FunctionDeclaration, registration: ts.Node, name: string, trusted: boolean, seen: Set<ts.Node>): void {
    if (seen.has(node)) { gap(registration, `Cyclic plugin metadata: ${name}`); return }
    seen = new Set([...seen, node])
    if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      if (!node.body) { gap(registration, `Missing plugin factory body: ${name}`); return }
      if (!ts.isBlock(node.body)) { inspect(node.body, registration, name, trusted, seen); return }
      let found = false
      const visit = (child: ts.Node) => {
        if (ts.isFunctionLike(child)) return
        if (ts.isReturnStatement(child) && child.expression) { found = true; inspect(child.expression, registration, name, trusted, seen) }
        else ts.forEachChild(child, visit)
      }
      ts.forEachChild(node.body, visit)
      if (!found) gap(registration, `Cannot establish plugin metadata: ${name}`)
      return
    }
    node = unwrapped(node)
    if (ts.isConditionalExpression(node)) {
      gap(node, `Conditional plugin metadata: ${name}`)
      inspect(node.whenTrue, registration, name, trusted, seen)
      inspect(node.whenFalse, registration, name, trusted, seen)
      return
    }
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === 'builtinPlugin' && node.arguments[0]) inspect(node.arguments[0], registration, name, trusted, seen)
      else inspect(node.expression, registration, name, trusted, seen)
      return
    }
    if (ts.isIdentifier(node)) {
      const tree = node.getSourceFile(), local = symbol(tree, node.text)
      if (local) { inspect(local, registration, name, trusted, seen); return }
      for (const statement of tree.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const clause = statement.importClause, names = clause?.namedBindings
        const binding = clause?.name?.text === node.text ? 'default' : names && ts.isNamedImports(names) ? names.elements.find(n => n.name.text === node.text) : undefined
        if (!binding) continue
        const specifier = statement.moduleSpecifier.text
        const resolved = ts.resolveModuleName(specifier, tree.fileName, { moduleResolution: ts.ModuleResolutionKind.Bundler }, ts.sys).resolvedModule?.resolvedFileName
        if (!resolved) break
        const exported = typeof binding === 'string' ? binding : (binding.propertyName ?? binding.name).text
        const value = symbol(read(resolved), exported)
        if (value) { inspect(value, registration, exported, trusted || specifier.startsWith('@workbasehq/plugins/'), seen); return }
      }
      gap(registration, `Cannot resolve plugin declaration: ${name}`); return
    }
    if (!ts.isObjectLiteralExpression(node)) { gap(registration, `Computed plugin metadata: ${name}`); return }
    const pluginName = property(node, 'name')?.initializer
    if (pluginName && ts.isStringLiteralLike(pluginName)) name = pluginName.text
    const spreads = node.properties.filter(ts.isSpreadAssignment)
    for (const spread of spreads) {
      gap(spread, `Spread plugin metadata: ${name}`)
      inspect(spread.expression, registration, name, trusted, seen)
    }
    // Any computed member can replace schemaReferences, even beside a literal declaration.
    for (const member of node.properties) if (member.name && ts.isComputedPropertyName(member.name)) gap(member, `Computed plugin metadata key: ${name}`)
    for (const key of ['requires', 'optionalRequires'] as const) {
      const value = property(node, key)?.initializer
      if (!value) continue
      const object = unwrapped(value)
      if (!ts.isObjectLiteralExpression(object)) { gap(value, `Computed contract requirements on ${name}`); continue }
      for (const p of object.properties) {
        if (!ts.isPropertyAssignment(p) || !ts.isStringLiteralLike(p.initializer) || ts.isComputedPropertyName(p.name)) { gap(p, `Computed contract requirement on ${name}`); continue }
        contracts.push({ plugin: name, contract: p.name.getText().replace(/^['"]|['"]$/g, ''), range: p.initializer.text, optional: key === 'optionalRequires', source: nodeSpan(p.name) })
      }
    }
    // Inspect every declaration, not just the first/effective one. Unsupported syntax
    // must never look like an omitted optional field or an empty inventory.
    const declarations = node.properties.filter(p => p.name && plainKey(p.name) === 'schemaReferences')
    if (!declarations.length) { if (!trusted) gap(node, `Plugin ${name} has no declared schema reference inventory.`); return }
    if (declarations.length > 1) gap(node, `Duplicate schema reference metadata on ${name}`)
    for (const declaration of declarations) {
      if (!ts.isPropertyAssignment(declaration) || !ts.isArrayLiteralExpression(declaration.initializer)) {
        gap(declaration, `Non-literal schema references on ${name}`); continue
      }
      for (const item of declaration.initializer.elements) {
        // This is an allowlist for the entire item: no ignored properties, spreads,
        // computed keys, duplicate keys, accessors, shorthand or evaluated values.
        const values = new Map<string, ts.StringLiteral>()
        const canonical = ts.isObjectLiteralExpression(item) && item.properties.every(p => {
          if (!ts.isPropertyAssignment(p)) return false
          const key = plainKey(p.name)
          if ((key !== 'entity' && key !== 'field') || values.has(key) || !ts.isStringLiteral(p.initializer)) return false
          values.set(key, p.initializer)
          return true
        })
        const entity = values.get('entity'), field = values.get('field')
        if (!canonical || !entity) { gap(item, `Non-canonical schema reference on ${name}`); continue }
        references.push({ kind: 'plugin', target: { entity: entity.text, ...(field ? { field: field.text } : {}) }, entityContext: entity.text,
          owner: `plugin:${name}`, source: nodeSpan(field ?? entity), useSites: [{ owner: `plugin:${name}`, entityContext: entity.text, source: nodeSpan(registration) }] })
      }
    }
  }
  const file = resolve(root, 'runtime.ts')
  if (existsSync(file)) {
    const tree = read(file), expression = symbol(tree, 'default')
    const object = expression && !ts.isFunctionDeclaration(expression) ? unwrapped(expression) : undefined
    if (!object || !ts.isObjectLiteralExpression(object)) {
      gap(expression ?? tree, 'Unresolved runtime export: plugin registration coverage is unknown.')
    } else {
      let plugins: ts.Expression | undefined, unknown: ts.Node | undefined
      for (const member of object.properties) {
        if (ts.isSpreadAssignment(member) || member.name && ts.isComputedPropertyName(member.name)) unknown = member
        else if (member.name?.getText().replace(/^['"]|['"]$/g, '') === 'plugins') {
          plugins = ts.isPropertyAssignment(member) ? unwrapped(member.initializer) : undefined
          // An explicit property overrides preceding spreads/computed keys.
          unknown = plugins ? undefined : member
        }
      }
      if (plugins && ts.isArrayLiteralExpression(plugins)) for (const item of plugins.elements) inspect(item, item, item.getText(), false, new Set())
      else if (plugins) gap(plugins, 'Computed runtime plugin registrations cannot be inventoried.')
      if (unknown) gap(unknown, 'Unresolved runtime properties: plugin registration coverage is unknown.')
    }
  }
  return { references, contracts, uncovered }
}
