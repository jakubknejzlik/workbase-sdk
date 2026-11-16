// Shared by offline verification and the standalone SDK upgrade bridge. Keep
// this module independent of the producer SDK and workflow implementation.
export type SqlTokenKind = 'keyword' | 'identifier' | 'quotedIdentifier' | 'string' | 'number' | 'blob' | 'operator' | 'punct' | 'param'
export type SqlToken = { kind: SqlTokenKind; value: string; raw: string }
export const foldIdentifier = (value: string) => value.replace(/[A-Z]/g, char => char.toLowerCase())
// SQLite's keyword set, plus the contextual boolean literals. Never classify a
// quoted spelling through this set (not even "null", "true" or "check").
const keywords = new Set(`ABORT ACTION ADD AFTER ALL ALTER ALWAYS ANALYZE AND AS ASC ATTACH AUTOINCREMENT BEFORE BEGIN BETWEEN BY CASCADE CASE CAST CHECK COLLATE COLUMN COMMIT CONFLICT CONSTRAINT CREATE CROSS CURRENT CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP DATABASE DEFAULT DEFERRABLE DEFERRED DELETE DESC DETACH DISTINCT DO DROP EACH ELSE END ESCAPE EXCEPT EXCLUDE EXCLUSIVE EXISTS EXPLAIN FAIL FILTER FIRST FOLLOWING FOR FOREIGN FROM FULL GENERATED GLOB GROUP GROUPS HAVING IF IGNORE IMMEDIATE IN INDEX INDEXED INITIALLY INNER INSERT INSTEAD INTERSECT INTO IS ISNULL JOIN KEY LAST LEFT LIKE LIMIT MATCH MATERIALIZED NATURAL NO NOT NOTHING NOTNULL NULL NULLS OF OFFSET ON OR ORDER OTHERS OUTER OVER PARTITION PLAN PRAGMA PRECEDING PRIMARY QUERY RAISE RANGE RECURSIVE REFERENCES REGEXP REINDEX RELEASE RENAME REPLACE RESTRICT RETURNING RIGHT ROLLBACK ROW ROWS SAVEPOINT SELECT SET TABLE TEMP TEMPORARY THEN TIES TO TRANSACTION TRIGGER UNBOUNDED UNION UNIQUE UPDATE USING VACUUM VALUES VIEW VIRTUAL WHEN WHERE WINDOW WITH WITHOUT TRUE FALSE`.toLowerCase().split(' '))

export class SqlTokenizationError extends Error {
  readonly code = 'sql_tokenization_unsupported'
  constructor(readonly offset: number) { super('SQL contains an unsupported or incomplete token') }
}
// SQLite accepts non-ASCII characters in identifiers without Unicode case
// folding. Use explicit ASCII whitespace; silently skipping JS-only whitespace
// could merge a real SQLite identifier into different SQL.
const idStart = (c: string | undefined) => c !== undefined && /[A-Za-z_\u0080-\uffff]/u.test(c)
const idContinue = (c: string | undefined) => c !== undefined && /[A-Za-z_0-9$\u0080-\uffff]/u.test(c)
export function tokenizeSQL(sql: string): SqlToken[] {
  const tokens: SqlToken[] = []
  let at = 0
  const fail = (): never => { throw new SqlTokenizationError(at) }
  const emit = (kind: SqlTokenKind, start: number, value = sql.slice(start, at)) => tokens.push({ kind, value, raw: sql.slice(start, at) })
  const quoted = (delimiter: string) => {
    at++
    let value = ''
    while (at < sql.length) {
      const char = sql[at++]
      if (char === '\0') fail()
      if (char !== delimiter) { value += char; continue }
      // SQLite bracket names terminate at the first ']'; unlike double quotes
      // and backticks, brackets have no doubled-delimiter escape.
      if (delimiter !== ']' && sql[at] === delimiter) { value += delimiter; at++; continue }
      return value
    }
    return fail()
  }
  while (at < sql.length) {
    const start = at, char = sql[at], next = sql[at + 1]
    if (/[ \t\n\r\f]/.test(char)) { at++; continue }
    if (char === '-' && next === '-') {
      at += 2
      while (at < sql.length && sql[at] !== '\n') { if (sql[at] === '\0') fail(); at++ }
      continue
    }
    if (char === '/' && next === '*') {
      at += 2
      while (at < sql.length && !(sql[at] === '*' && sql[at + 1] === '/')) { if (sql[at] === '\0') fail(); at++ }
      if (at === sql.length) fail()
      at += 2; continue
    }
    if ((char === 'x' || char === 'X') && next === "'") {
      at++
      const value = quoted("'")
      if (!/^(?:[0-9a-f]{2})*$/i.test(value)) fail()
      emit('blob', start, value); continue
    }
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const value = quoted(char === '[' ? ']' : char)
      emit(char === "'" ? 'string' : 'quotedIdentifier', start, value); continue
    }
    if (/[0-9]/.test(char) || (char === '.' && next !== undefined && /[0-9]/.test(next))) {
      // Keep numeric spelling rather than converting through JS Number (which
      // would lose precision). Underscores and exponent/hex spelling are tokens.
      const number = /^(?:0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*|(?:[0-9](?:_?[0-9])*(?:\.(?:[0-9](?:_?[0-9])*)?)?|\.[0-9](?:_?[0-9])*)(?:[eE][+-]?[0-9](?:_?[0-9])*)?)/.exec(sql.slice(at))
      if (!number) fail()
      at += number![0].length
      if (idContinue(sql[at])) fail()
      emit('number', start); continue
    }
    if (char === '?' || char === ':' || char === '@' || char === '$') {
      at++
      if (char === '?') { while (/[0-9]/.test(sql[at] ?? '')) at++ }
      else {
        const nameStart = at
        while (idContinue(sql[at])) at++
        if (at === nameStart) fail()
        // Tcl's extended $name::suffix(...) form is deliberately unsupported;
        // fail rather than split it into misleading ordinary tokens.
        if (char === '$' && (sql[at] === ':' || sql[at] === '(')) fail()
      }
      emit('param', start); continue
    }
    if (idStart(char)) {
      at++
      while (idContinue(sql[at])) at++
      emit(keywords.has(foldIdentifier(sql.slice(start, at))) ? 'keyword' : 'identifier', start); continue
    }
    const operator = /^(?:->>|->|\|\||<<|>>|<=|>=|==|!=|<>|[+*/%~&|<>=-])/.exec(sql.slice(at))
    if (operator) { at += operator[0].length; emit('operator', start); continue }
    if ('(),.;'.includes(char)) { at++; emit('punct', start); continue }
    fail()
  }
  return tokens
}
export const isKeyword = (token: SqlToken | undefined, word: string) => token?.kind === 'keyword' && foldIdentifier(token.value) === word
export const isPunct = (token: SqlToken | undefined, value: string) => token?.kind === 'punct' && token.value === value

// Only fold identifier case/resolve quoting where the caller knows the name
// denotes an identifier (a bare DEFAULT name can instead be a string).
// Unknown double-quoted text can be a SQLite DQS string: preserve its
// exact case. Quoted keyword names always retain their kind.
export function normalizedToken(token: SqlToken, identifiers: ReadonlySet<string> = new Set()): readonly [SqlTokenKind, string] {
  if (token.kind === 'keyword') return [token.kind, foldIdentifier(token.value)]
  if (token.kind === 'identifier') return [token.kind, identifiers.has(foldIdentifier(token.value)) ? foldIdentifier(token.value) : token.value]
  if (token.kind === 'blob' || token.kind === 'number') return [token.kind, foldIdentifier(token.value)]
  if (token.kind === 'quotedIdentifier' && identifiers.has(foldIdentifier(token.value))) {
    const name = foldIdentifier(token.value)
    const bare = /^[a-z_][a-z_0-9$]*$/.test(name) && !keywords.has(name)
    return [bare ? 'identifier' : token.kind, name]
  }
  // An unresolved double-quoted spelling may be a DQS string, whereas the
  // same bracket/backtick spelling would be an unresolved identifier. Keep the
  // delimiter too until the caller can establish a name binding.
  return [token.kind, token.kind === 'quotedIdentifier' ? token.raw : token.value]
}
export const tokenFingerprint = (tokens: readonly SqlToken[], identifiers?: ReadonlySet<string>) => JSON.stringify(tokens.map(token => normalizedToken(token, identifiers)))
export function sqlFingerprint(sql: string, identifiers?: ReadonlySet<string>) {
  const tokens = tokenizeSQL(sql)
  if (isPunct(tokens.at(-1), ';')) tokens.pop()
  return tokenFingerprint(tokens, identifiers)
}
