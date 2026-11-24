import ts from 'typescript'

/** Closed vocabulary for a tracked value's immediate publication/use edge.
 * Adding syntax support requires an explicit modeled edge here. Unknown kinds,
 * assignments (either side), argument publication and effects always fail closed.
 */
export function publicationStep(parent: ts.Node, child: ts.Node): 'next' | 'binding' | 'declaration' | 'returned' | 'exported' | 'gap' {
  if (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent)
    || ts.isSatisfiesExpression(parent) || ts.isNonNullExpression(parent)) return parent.expression === child ? 'next' : 'gap'
  if (ts.isPropertyAccessExpression(parent)) return parent.expression === child ? 'next' : 'declaration'
  if (ts.isPropertyAssignment(parent)) return parent.initializer === child ? 'next' : 'declaration'
  if (ts.isShorthandPropertyAssignment(parent)) return parent.name === child && !parent.objectAssignmentInitializer ? 'next' : 'gap'
  if (ts.isObjectLiteralExpression(parent) || ts.isArrayLiteralExpression(parent)
    || ts.isSpreadAssignment(parent) || ts.isSpreadElement(parent) || ts.isConditionalExpression(parent)) return 'next'
  if (ts.isBindingElement(parent) && parent.propertyName === child) return 'declaration'
  if (ts.isVariableDeclaration(parent)) return parent.initializer === child ? 'binding' : parent.name === child ? 'declaration' : 'gap'
  if (ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent)
    || ts.isClassExpression(parent) || ts.isParameter(parent)) return parent.name === child ? 'declaration' : 'gap'
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)
    || ts.isExportSpecifier(parent)) return 'declaration' // static owners/consumers are checked separately
  if (ts.isReturnStatement(parent) || ts.isArrowFunction(parent) && parent.body === child) return 'returned'
  if (ts.isExportAssignment(parent)) return !parent.isExportEquals ? 'exported' : 'gap'
  if (ts.isCallExpression(parent)) return parent.expression === child && ts.isIdentifier(child) ? 'next' : 'gap'
  if (ts.isBinaryExpression(parent) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken,
    ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(parent.operatorToken.kind)) return 'next'
  // A proven condition may read a scalar binding; neither branch publishes it.
  if (ts.isIfStatement(parent) && parent.expression === child) return 'declaration'
  return 'gap'
}
