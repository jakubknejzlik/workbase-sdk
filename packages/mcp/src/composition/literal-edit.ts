import ts from 'typescript'
import { SourceError } from '@workbasehq/core/schema/load'

function unwrap(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node) ? unwrap(node.expression) : node
}
/** The loader validates the module first. Edit only an initializer's token span;
 * trivia, declarations, imports and all other authored bytes remain untouched. */
export function replaceLiteral(text: string, path: readonly string[], value: unknown, file: string, options: { config?: boolean; insert?: boolean } = {}): string {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const error = (node: ts.Node, message: string): never => {
    const pos = source.getLineAndCharacterOfPosition(node.getStart(source))
    throw new SourceError({ file, line: pos.line + 1, column: pos.character + 1 }, message)
  }
  const calls: ts.CallExpression[] = []
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const expression = unwrap(statement.expression)
      if (ts.isCallExpression(expression)) calls.push(expression)
    }
    if (ts.isVariableStatement(statement) && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of statement.declarationList.declarations) {
        const expression = declaration.initializer && unwrap(declaration.initializer)
        if (expression && ts.isCallExpression(expression)) calls.push(expression)
      }
    }
  }
  if (calls.length !== 1 || !options.config && calls[0].arguments.length !== 1) error(source, 'Expected one literal declaration')
  let declaration = calls[0]
  // loadConfig has already validated SDK bindOpenApi/bindSchemaLock wrappers.
  if (options.config) while (ts.isCallExpression(unwrap(declaration.arguments[0]))) declaration = unwrap(declaration.arguments[0]) as ts.CallExpression
  let node = unwrap(declaration.arguments[0])
  for (const [position, name] of path.entries()) {
    if (!ts.isObjectLiteralExpression(node)) error(node, 'Expected a literal object')
    const property = (node as ts.ObjectLiteralExpression).properties.find(property => property.name
      && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name)) && property.name.text === name)
    if (!property && (options.config || options.insert) && position === path.length - 1) {
      const object = node as ts.ObjectLiteralExpression
      const end = object.getEnd() - 1
      const separator = object.properties.length && !object.properties.hasTrailingComma ? ',' : ''
      return text.slice(0, end) + `${separator}\n  ${JSON.stringify(name)}: ${JSON.stringify(value, null, 2)}\n` + text.slice(end)
    }
    if (!property || !ts.isPropertyAssignment(property)) error(node, `Missing literal property: ${name}`)
    node = unwrap((property as ts.PropertyAssignment).initializer)
  }
  return text.slice(0, node.getStart(source)) + JSON.stringify(value, null, 2) + text.slice(node.getEnd())
}
