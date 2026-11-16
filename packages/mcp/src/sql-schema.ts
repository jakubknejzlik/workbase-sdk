// The consumption grammar is shared with the isolated SDK upgrade bridge.
import { tokenizeSQL, tokenFingerprint, normalizedToken, identifierToken, foldIdentifier, isKeyword, isPunct, type SqlToken } from './sql-tokens.ts'

export class SqlSchemaError extends Error {
  readonly code = 'config_schema_mismatch'
  constructor() { super('Schema contains semantics unsupported by offline verification') }
}
function unsupportedSchema(): never { throw new SqlSchemaError() }
function canonicalCheck(input: SqlToken[], identifiers: ReadonlySet<string>) {
  let tokens = [...input]
  // Preserve the existing equivalences: redundant outer parentheses and the
  // order of simple string/decimal literal IN lists. Inspect token kinds.
  while (isPunct(tokens[0], '(') && isPunct(tokens.at(-1), ')')) {
    let depth = 0
    if (tokens.some((token, i) => { depth += isPunct(token, '(') ? 1 : isPunct(token, ')') ? -1 : 0; return depth === 0 && i < tokens.length - 1 })) break
    tokens = tokens.slice(1, -1)
  }
  for (let i = 0; i < tokens.length; i++) {
    if (!isKeyword(tokens[i], 'in') || !isPunct(tokens[i + 1], '(')) continue
    let end = i + 2
    while (end < tokens.length && !isPunct(tokens[end], ')')) end++
    const list = tokens.slice(i + 2, end)
    if (end < tokens.length && list.length % 2 === 1 && list.every((token, j) => j % 2 ? isPunct(token, ',')
      : token.kind === 'string' || (token.kind === 'number' && /^\d+(?:\.\d+)?$/.test(token.value)))) {
      const values = list.filter((_, j) => j % 2 === 0).sort((a, b) => {
        const left = tokenFingerprint([a]), right = tokenFingerprint([b])
        return left < right ? -1 : left > right ? 1 : 0
      })
      tokens.splice(i + 2, list.length, ...values.flatMap((token, j) => j ? [list[1], token] : [token]))
    }
  }
  return tokenFingerprint(tokens, identifiers)
}
// PRAGMAs omit column collations, conflict policies, generated expressions and
// FK deferral. Consume every clause; unknown syntax fails even on both sides.
// Grammar decisions are made on typed tokens, before fingerprinting.
export function tableSemantics(tokens: SqlToken[], columns: { name: unknown; type: unknown }[]) {
  const identifiers = new Set(columns.map(column => foldIdentifier(String(column.name))))
  const generated: { name: string; expression: string }[] = [], checks: string[] = []
  let at = 0
  const take = (word: string) => isKeyword(tokens[at], word) ? (++at, true) : false
  const need = (word: string) => { if (!take(word)) unsupportedSchema() }
  const contextual = (word: string) => tokens[at]?.kind === 'identifier' && foldIdentifier(tokens[at].value) === word ? (++at, true) : false
  const punct = (value: string) => isPunct(tokens[at], value) ? (++at, true) : false
  const needPunct = (value: string) => { if (!punct(value)) unsupportedSchema() }
  const identifier = () => {
    const token = tokens[at++]
    if (!token || !['identifier', 'quotedIdentifier', 'keyword'].includes(token.kind)) unsupportedSchema()
    return foldIdentifier(token.value)
  }
  const group = () => {
    const start = at
    needPunct('(')
    let depth = 1
    while (depth && at < tokens.length) {
      const token = tokens[at++]
      depth += isPunct(token, '(') ? 1 : isPunct(token, ')') ? -1 : 0
    }
    if (depth || at - start <= 2) unsupportedSchema()
    return tokens.slice(start, at)
  }
  const check = () => checks.push(canonicalCheck(group().slice(1, -1), identifiers))
  const reference = () => {
    identifier()
    if (isPunct(tokens[at], '(')) group()
    while (take('on')) {
      if (!take('delete') && !take('update')) unsupportedSchema()
      if (take('set')) { if (!take('null') && !take('default')) unsupportedSchema() }
      else if (take('no')) need('action')
      else if (!take('cascade') && !take('restrict')) unsupportedSchema()
    }
  }
  need('create'); need('table'); identifier(); needPunct('(')
  do {
    const namedConstraint = take('constraint')
    if (namedConstraint) identifier()
    if (take('primary')) { need('key'); group() }
    else if (take('unique')) group()
    else if (take('check')) check()
    else if (take('foreign')) { need('key'); group(); need('references'); reference() }
    else {
      if (namedConstraint) unsupportedSchema()
      const name = identifier()
      const column = columns.find(c => foldIdentifier(String(c.name)) === name)
      if (!column) unsupportedSchema()
      const typeTokens = tokenizeSQL(String(column.type))
      const typeNames = new Set(typeTokens.map(token => foldIdentifier(token.value)))
      for (const token of typeTokens) {
        if (JSON.stringify(normalizedToken(tokens[at] ?? unsupportedSchema(), typeNames)) !== JSON.stringify(normalizedToken(token, typeNames))) unsupportedSchema()
        at++
      }
      while (!isPunct(tokens[at], ',') && !isPunct(tokens[at], ')') && at < tokens.length) {
        if (take('constraint')) identifier()
        else if (take('not')) need('null')
        else if (take('null') || take('unique')) { /* represented in column/index metadata */ }
        else if (take('primary')) { need('key'); take('asc') || take('desc') }
        else if (take('check')) check()
        else if (take('references')) reference()
        else if (isKeyword(tokens[at], 'generated') || isKeyword(tokens[at], 'as')) {
          if (take('generated')) take('always')
          need('as')
          generated.push({ name, expression: tokenFingerprint(group(), identifiers) })
          take('virtual') || contextual('stored')
        }
        else if (take('default')) {
          if (isPunct(tokens[at], '(')) group()
          else {
            if (tokens[at]?.kind === 'operator' && ['+', '-'].includes(tokens[at].value)) at++
            const token = tokens[at++]
            if (!token || !['string', 'number', 'blob', 'quotedIdentifier', 'identifier'].includes(token.kind)
              && !(token.kind === 'keyword' && ['null', 'true', 'false', 'current_date', 'current_time', 'current_timestamp'].includes(foldIdentifier(token.value)))) unsupportedSchema()
          }
        } else unsupportedSchema()
      }
    }
  } while (punct(','))
  needPunct(')')
  if (at < tokens.length) do {
    if (take('without')) {
      if (!contextual('rowid')) unsupportedSchema()
    } else if (!contextual('strict')) unsupportedSchema()
  } while (punct(','))
  if (at !== tokens.length) unsupportedSchema()
  return { generated: generated.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), checks: checks.sort() }
}

// The object declaration is a name position. Do not apply its name binding to
// later expression tokens: the same quoted spelling could be a DQS literal.
export function ddlFingerprint(sql: string, type: string, name: string, scope?: { table: string; columns: readonly string[] }) {
  const tokens = tokenizeSQL(sql)
  if (isPunct(tokens.at(-1), ';')) tokens.pop()
  let nameAt = 1
  if (!isKeyword(tokens[0], 'create')) unsupportedSchema()
  while (['unique', 'temp', 'temporary'].some(word => isKeyword(tokens[nameAt], word))) nameAt++
  if (!isKeyword(tokens[nameAt++], type)) unsupportedSchema()
  if (isKeyword(tokens[nameAt], 'if')) {
    if (!isKeyword(tokens[nameAt + 1], 'not') || !isKeyword(tokens[nameAt + 2], 'exists')) unsupportedSchema()
    nameAt += 3
  }
  const token = tokens[nameAt]
  if (!token || !['identifier', 'quotedIdentifier', 'keyword'].includes(token.kind) || foldIdentifier(token.value) !== foldIdentifier(name)) unsupportedSchema()
  const fingerprint = tokens.map(token => normalizedToken(token))
  fingerprint[nameAt] = identifierToken(token)
  if (type === 'index') {
    // sqlite_master binds the ON table; table_xinfo supplies the expression
    // scope. Never bind an index/table name throughout the rest of its DDL.
    if (!scope || !isKeyword(tokens[nameAt + 1], 'on')) unsupportedSchema()
    const tableAt = nameAt + 2, table = tokens[tableAt]
    if (!table || !['identifier', 'quotedIdentifier', 'keyword'].includes(table.kind)
      || foldIdentifier(table.value) !== foldIdentifier(scope.table) || !isPunct(tokens[tableAt + 1], '(')) unsupportedSchema()
    fingerprint[tableAt] = identifierToken(table)
    const columns = new Set(scope.columns.map(foldIdentifier))
    for (let i = tableAt + 2; i < tokens.length; i++) {
      const current = tokens[i]
      // COLLATE names and function names occupy identifier roles regardless
      // of whether a column happens to share their spelling.
      const nameRole = isKeyword(tokens[i - 1], 'collate')
        || (['identifier', 'quotedIdentifier'].includes(current.kind) && isPunct(tokens[i + 1], '('))
      fingerprint[i] = nameRole ? identifierToken(current) : normalizedToken(current, columns)
    }
  }
  return JSON.stringify(fingerprint)
}
