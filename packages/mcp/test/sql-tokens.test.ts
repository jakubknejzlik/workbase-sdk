import { expect, it } from 'vitest'
import { tokenizeSQL, sqlFingerprint, normalizedToken, SqlTokenizationError } from '../src/sql-tokens'

it('retains token kinds, decoded values and lossless raw spellings', () => {
  expect(tokenizeSQL('cHeCk "nu""ll" `a``b` [null] \'it\'\'s\' X\'aB00\' 1.2e-3 <= ( ?12, :name, @Name, $value )')).toEqual([
    { kind: 'keyword', value: 'cHeCk', raw: 'cHeCk' },
    { kind: 'quotedIdentifier', value: 'nu"ll', raw: '"nu""ll"' },
    { kind: 'quotedIdentifier', value: 'a`b', raw: '`a``b`' },
    { kind: 'quotedIdentifier', value: 'null', raw: '[null]' },
    { kind: 'string', value: "it's", raw: "'it''s'" },
    { kind: 'blob', value: 'aB00', raw: "X'aB00'" },
    { kind: 'number', value: '1.2e-3', raw: '1.2e-3' },
    { kind: 'operator', value: '<=', raw: '<=' },
    { kind: 'punct', value: '(', raw: '(' },
    { kind: 'param', value: '?12', raw: '?12' },
    { kind: 'punct', value: ',', raw: ',' },
    { kind: 'param', value: ':name', raw: ':name' },
    { kind: 'punct', value: ',', raw: ',' },
    { kind: 'param', value: '@Name', raw: '@Name' },
    { kind: 'punct', value: ',', raw: ',' },
    { kind: 'param', value: '$value', raw: '$value' },
    { kind: 'punct', value: ')', raw: ')' },
  ])
})
it('ignores comments without merging tokens or consuming comment-like quoted text', () => {
  expect(sqlFingerprint('CHECK/* mid */(n -- line\n IN (0,1)); -- tail'))
    .toBe(sqlFingerprint('check(n in(0,1))'))
  expect(tokenizeSQL("'--' '/* */' \"--\" `/*` [--]").map(t => t.value)).toEqual(['--', '/* */', '--', '/*', '--'])
  expect(sqlFingerprint('a/**/b')).not.toBe(sqlFingerprint('ab'))
})
it.each(['"null"', '[null]', '`null`', '"true"', '"false"', '"check"'])('preserves quoted kind for %s', sql => {
  const token = tokenizeSQL(sql)[0]
  expect(normalizedToken(token, new Set([token.value]))[0]).toBe('quotedIdentifier')
  expect(sqlFingerprint(sql)).not.toBe(sqlFingerprint(token.value))
})
it('resolves identifier quoting only for known column names and folds ASCII only', () => {
  const known = new Set(['name', 'ä'])
  expect(normalizedToken(tokenizeSQL('"NaMe"')[0], known)).toEqual(['identifier', 'name'])
  expect(normalizedToken(tokenizeSQL('"NaMe"')[0])).toEqual(['quotedIdentifier', '"NaMe"'])
  expect(sqlFingerprint('Ä')).not.toBe(sqlFingerprint('ä'))
  expect(sqlFingerprint(':Name')).not.toBe(sqlFingerprint(':name'))
})
it('keeps maximal numeric and operator tokens without JS numeric precision loss', () => {
  expect(tokenizeSQL('0xAB 1_000 .5 1. 1E+3 9007199254740993 ->> -> << >> != <> || ==').map(t => t.raw))
    .toEqual(['0xAB', '1_000', '.5', '1.', '1E+3', '9007199254740993', '->>', '->', '<<', '>>', '!=', '<>', '||', '=='])
  expect(sqlFingerprint('9007199254740992')).not.toBe(sqlFingerprint('9007199254740993'))
})
it.each(['"unterminated', '`unterminated', '[unterminated', "'unterminated", '/* unterminated', "X'0'", "X'gg'", '0x', '1e+', '1__2', ':', '@', '$name::suffix(x)', '!', '\0', "'a\0b'"])(
  'fails closed with a typed lexical diagnostic for %j', sql => {
    expect(() => tokenizeSQL(sql)).toThrow(SqlTokenizationError)
    try { tokenizeSQL(sql) } catch (error) { expect(error).toMatchObject({ code: 'sql_tokenization_unsupported', offset: expect.any(Number) }) }
  },
)
it('implements SQLite bracket termination without inventing a bracket escape', () => {
  expect(() => tokenizeSQL('[a]]b]')).toThrow(SqlTokenizationError)
})

it('keeps unresolved quote forms distinct because only double quotes allow DQS fallback', () => {
  expect(sqlFingerprint('"unknown"')).not.toBe(sqlFingerprint('[unknown]'))
  expect(sqlFingerprint('"unknown"')).not.toBe(sqlFingerprint('`unknown`'))
})
