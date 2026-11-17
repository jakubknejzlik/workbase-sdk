/** Trace normalized SDK data back through literal/helper/import nodes. This does
 * not evaluate UI code or implement validation; checkSources/normalise own that. */
import ts from 'typescript'
import { dirname, extname, resolve } from 'node:path'
import { nodeSpan, type ReferenceSpan } from '@workbasehq/core/references'
import type { Sources } from './sources'
export function referenceOrigins(sources: Sources) {
  const trees = new Map([...sources.modules].map(([file, text]) => [file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)]))
  type Origin = { source: ReferenceSpan; uses: ReferenceSpan[]; exact: boolean }
  function trace(node: ts.Expression, path: string[], uses: ReferenceSpan[], seen: Set<ts.Node>): Origin {
    const fallback = () => ({ source: nodeSpan(node), uses, exact: false })
    if (seen.has(node)) return fallback()
    seen = new Set([...seen, node])
    const tree = node.getSourceFile()
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node)) return trace(node.expression, path, uses, seen)
    if (ts.isIdentifier(node)) {
      for (const statement of tree.statements) {
        if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === node.text && declaration.initializer) return trace(declaration.initializer, path, [...uses, nodeSpan(node)], seen)
        }
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.moduleSpecifier.text.startsWith('.')) continue
        const clause = statement.importClause, bindings = clause?.namedBindings
        const binding = clause?.name?.text === node.text ? 'default' : bindings && ts.isNamedImports(bindings)
          ? bindings.elements.find(item => item.name.text === node.text) : undefined
        if (!binding) continue
        const base = resolve(dirname(tree.fileName), statement.moduleSpecifier.text)
        const imported = trees.get(base) ?? (!extname(base) ? trees.get(base + '.ts') : undefined)
        if (!imported) return fallback()
        const exported = typeof binding === 'string' ? binding : (binding.propertyName ?? binding.name).text
        const expression = exportExpression(imported, exported)
        if (expression) return trace(expression, path, [...uses, nodeSpan(node)], seen)
      }
      return fallback()
    }
    if (ts.isPropertyAccessExpression(node)) return trace(node.expression, [node.name.text, ...path], uses, seen)
    if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)) return trace(node.expression, [node.argumentExpression.text, ...path], uses, seen)
    if (ts.isCallExpression(node)) {
      const call = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ''
      const local = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) ? node.expression.expression.text : ''
      let helper = ''
      for (const statement of tree.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
        && statement.moduleSpecifier.text === '@workbasehq/plugins/console/ui' && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
        const name = statement.importClause.namedBindings.elements.find(item => item.name.text === local)
        if (name) helper = (name.propertyName ?? name.name).text
      }
      if (!helper) return fallback()
      const [head, ...rest] = path
      let arg: ts.Expression | undefined, tail = path
      if (helper.startsWith('entity') && helper.endsWith('Page')) {
        if (head === 'entity' || head === 'data' && ['records', 'record'].includes(rest[0]) && rest[1] === 'entity' || head === 'params' && rest[1] === 'entity') { arg = node.arguments[0]; tail = [] }
        else { arg = node.arguments[1]; tail = path }
      } else if (['page', 'customPage', 'defineNav', 'defineSlots', 'defineKeys', 'layout'].includes(helper)) arg = node.arguments[0]
      else if (helper === 'col') { arg = node.arguments[head === 'span' ? 1 : 0]; tail = head === 'span' ? rest : rest.slice(1) }
      else if (helper === 'slot') { arg = node.arguments[head === 'id' ? 0 : 1]; tail = head === 'id' ? [] : rest }
      else if (helper === 'action') { arg = node.arguments[0]; tail = [] }
      else if (['link', 'one', 'list'].includes(helper)) { arg = node.arguments[head === 'entity' ? 0 : 1]; tail = head === 'entity' || head === 'mode' ? [] : rest }
      else if (helper === 'param' && call === 'id') { arg = node.arguments[0]; tail = [] }
      else if (helper === 'p' && call === 'field') { arg = node.arguments[0]; tail = [] }
      if (arg) return trace(arg, tail, uses, seen)
      return fallback()
    }
    if (!path.length) return { source: nodeSpan(node), uses, exact: true }
    const [head, ...tail] = path
    if (ts.isArrayLiteralExpression(node)) {
      // Spreads shift indices. Refuse guessed provenance rather than text-matching.
      if (node.elements.some(ts.isSpreadElement)) return fallback()
      const child = node.elements[Number(head)]
      return child ? trace(child, tail, uses, seen) : fallback()
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of [...node.properties].reverse()) {
        if (ts.isSpreadAssignment(property)) return trace(property.expression, path, [...uses, nodeSpan(property)], seen)
        if (!property.name || ts.isComputedPropertyName(property.name)) continue
        if (property.name.getText(tree).replace(/^['"]|['"]$/g, '') !== head) continue
        if (ts.isPropertyAssignment(property)) return trace(property.initializer, tail, uses, seen)
        if (ts.isShorthandPropertyAssignment(property)) return trace(property.name, tail, uses, seen)
      }
    }
    return fallback()
  }
  function exportExpression(tree: ts.SourceFile, name: string): ts.Expression | undefined {
    for (const statement of tree.statements) {
      if (name === 'default' && ts.isExportAssignment(statement)) return statement.expression
      if (ts.isVariableStatement(statement) && statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration.initializer
      }
    }
  }
  return (file: string, path: string[]): Origin => {
    const tree = trees.get(file)
    const expression = tree && exportExpression(tree, 'default')
    if (!tree || !expression) throw new Error(`Missing checked declaration ${file}`)
    return trace(expression, path, [], new Set())
  }
}
