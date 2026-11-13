import ts from 'typescript'
import { sourceAt, type Scan } from './validate'
/** Only admitted TSX sources contribute authored translation calls. */
export function scanTSX(modules: ReadonlyMap<string, string>, families: Record<string, string[]>): Scan {
  const result: Scan = { keys: new Map(), families: new Set(), findings: [] }
  for (const [file, text] of modules) {
    if (!file.endsWith('.tsx')) continue
    const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const names = new Set<string>()
    for (const statement of tree.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === '@workbasehq/plugins/console/ui/i18n' && !statement.importClause?.isTypeOnly) {
      const bindings = statement.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) if (!item.isTypeOnly && (item.propertyName ?? item.name).text === 't') names.add(item.name.text)
    }
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && names.has(node.expression.text)) {
        const arg = node.arguments[0], location = sourceAt(file, text.slice(0, node.getStart()))
        // Source positions must point at the call, including repeated keys.
        const pos = tree.getLineAndCharacterOfPosition(node.getStart())
        location.line = pos.line + 1; location.col = pos.character + 1
        if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
          const key = arg.text.includes(':') ? arg.text : 'ui:' + arg.text
          result.keys.set(key, [...result.keys.get(key) ?? [], location])
        } else if (arg && ts.isTemplateExpression(arg) && arg.templateSpans.length === 1 && arg.templateSpans[0].literal.text === '' && Object.hasOwn(families, arg.head.text.replace(/\.$/, ''))) {
          result.families.add(arg.head.text.replace(/\.$/, ''))
        } else result.findings.push({ code: 'dynamic-key', ...location })
      }
      ts.forEachChild(node, visit)
    }
    visit(tree)
  }
  return result
}
