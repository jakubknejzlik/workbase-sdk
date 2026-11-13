import ts from 'typescript'
import type { Scan } from './validate'
const attributes = new Set(['title', 'alt', 'placeholder', 'label', 'aria-label', 'aria-description', 'aria-placeholder', 'aria-roledescription', 'aria-valuetext'])
/** Guard admitted TSX against accidental authored text; this is not data-flow analysis. */
export function scanTSX(modules: ReadonlyMap<string, string>, families: Record<string, string[]>): Scan {
  const result: Scan = { keys: new Map(), families: new Set(), findings: [] }
  const host = ts.createCompilerHost({ noLib: true, noResolve: true })
  host.getSourceFile = file => modules.has(file) ? ts.createSourceFile(file, modules.get(file)!, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX) : undefined
  const program = ts.createProgram([...modules.keys()].filter(f => f.endsWith('.tsx')), { noLib: true, noResolve: true }, host), checker = program.getTypeChecker()
  for (const file of modules.keys()) {
    if (!file.endsWith('.tsx')) continue
    const tree = program.getSourceFile(file)!
    const location = (node: ts.Node) => {
      const pos = tree.getLineAndCharacterOfPosition(node.getStart(tree))
      return { file, line: pos.line + 1, col: pos.character + 1 }
    }
    const emit = (code: string, node: ts.Node) => result.findings.push({ code, ...location(node) })
    const importedT = (node: ts.Identifier) => checker.getSymbolAtLocation(node)?.declarations?.find(d => ts.isImportSpecifier(d) && (d.propertyName ?? d.name).text === 't') as ts.ImportSpecifier | undefined
    function sdkT(node: ts.Identifier) {
      const declaration = importedT(node), clause = declaration?.parent.parent, statement = clause?.parent
      return declaration && !declaration.isTypeOnly && clause && ts.isImportClause(clause) && !clause.isTypeOnly && statement && ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === '@workbasehq/plugins/console/ui/i18n'
    }
    function literal(node: ts.Node) {
      if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) emit('bare-text', node)
      else if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) literal(node.expression)
      else if (ts.isConditionalExpression(node)) { literal(node.whenTrue); literal(node.whenFalse) }
      else if (ts.isBinaryExpression(node)) {
        if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) literal(node.left)
        if ([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) literal(node.right)
      }
    }
    function visit(node: ts.Node) {
      if (ts.isJsxText(node) && /\p{L}/u.test(node.text)) emit('bare-text', node)
      if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) literal(node.expression)
      if (ts.isJsxAttribute(node) && attributes.has(node.name.getText(tree)) && node.initializer) {
        if (ts.isJsxExpression(node.initializer)) { if (node.initializer.expression) literal(node.initializer.expression) }
        else literal(node.initializer)
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && (node.expression.text === 't' || importedT(node.expression))) {
        if (!sdkT(node.expression)) emit('unbound-t', node)
        else {
          const arg = node.arguments[0], at = location(node)
          if (arg && ts.isStringLiteralLike(arg)) {
            const key = arg.text.includes(':') ? arg.text : 'ui:' + arg.text
            result.keys.set(key, [...result.keys.get(key) ?? [], at])
          } else if (arg && ts.isTemplateExpression(arg) && arg.templateSpans.length === 1 && arg.templateSpans[0].literal.text === '' && Object.hasOwn(families, arg.head.text.replace(/\.$/, ''))) result.families.add(arg.head.text.replace(/\.$/, ''))
          else emit('dynamic-key', node)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(tree)
  }
  return result
}
