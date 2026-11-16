import { env } from 'cloudflare:workers'
import { reset } from 'cloudflare:test'
import { beforeEach, expect, it } from 'vitest'
import { defineInstance } from '../src/config'
import { plan } from '../src/migrations/planner'
import { createEntity, initialSchema, literal } from '../src/migrations/schema'

beforeEach(reset)

const nameDefault = "Keep, (a 'quoted' value)"

function fixture(minimum = 1e-7, defaultValue = 1) {
  const from = defineInstance({ id: 'numeric_ref', revision: 1, roles: ['owner'], entities: {
    people: { fields: {
      name: { type: 'string', default: nameDefault }, n: { type: 'float', min: minimum, default: defaultValue },
      fraction: { type: 'float', min: 0.5, default: 0.5 }, negative: { type: 'int', min: -1, default: -1 },
      parent: { type: 'ref', entity: 'people' },
    } },
  } })
  const to = defineInstance({ ...from, revision: 2, entities: { people: { ...from.entities.people,
    fields: { ...from.entities.people.fields, link: { type: 'ref', entity: 'people' } },
  } } })
  return { from, to }
}

async function apply(sql: string) {
  return env.DB.batch(sql.split('\n').filter(line => !line.startsWith('--')).join('\n').split(';')
    .filter(statement => statement.trim()).map(statement => env.DB.prepare(statement)))
}
async function seed() {
  await apply(`INSERT INTO organizations VALUES ('org','Org');
    INSERT INTO people (id,organization_id,name,created_at,updated_at) VALUES ('p','org','Person','created','updated');`)
}
async function snapshot() {
  return {
    schema: (await env.DB.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY type,name').all()).results,
    rows: (await env.DB.prepare('SELECT * FROM people ORDER BY id').all()).results,
    revisions: (await env.DB.prepare('SELECT * FROM instance_meta ORDER BY revision').all()).results,
  }
}

it.each([
  [1e-7, 1, '"1e"-7', 0],
  [1e+21, 1e+21, '"1e"+21', 22],
] as const)('refuses numeric exponent %s replaced by an identifier expression', async (minimum, defaultValue, expression, probe) => {
  const { from, to } = fixture(minimum, defaultValue)
  const original = createEntity('people', from.entities.people)
  const changed = original.replace(`CHECK ("n" >= ${minimum})`, `CHECK ("n" >= ${expression})`)
  expect(changed).not.toBe(original)
  await apply(initialSchema(from).replace(original, changed)); await seed()
  // Both schemas accept the populated row, but only the drifted CHECK accepts this value.
  await env.DB.prepare('UPDATE people SET n=?').bind(probe).run()
  await env.DB.prepare('UPDATE people SET n=?').bind(defaultValue).run()
  const before = await snapshot()
  await expect(apply(plan(from, to).sql)).rejects.toThrow(/rebuild_requires_review_people_inline_constraints/)
  expect(await snapshot()).toEqual(before)
  expect(await env.DB.prepare('SELECT max(revision) n FROM instance_meta').first('n')).toBe(1)
  await env.DB.prepare('UPDATE people SET n=?').bind(probe).run()
})

it('accepts unchanged numeric CHECK and DEFAULT literals on first rebuild and linked replay', async () => {
  const { from, to } = fixture(1e-7, 1e-7)
  const sql = createEntity('people', from.entities.people)
  for (const numeric of ['1e-7', '0.5', '-1']) expect(sql).toContain(numeric)
  await apply(plan(null, from).sql); await seed()
  const before = (await snapshot()).rows
  const migration = plan(from, to)
  expect(migration.blocked).toEqual([])
  await apply(migration.sql)
  expect((await snapshot()).rows).toEqual(before.map(row => ({ ...row, link: null })))
  expect(await env.DB.prepare('SELECT n,fraction,negative FROM people').first()).toEqual({ n: 1e-7, fraction: 0.5, negative: -1 })
  await env.DB.prepare("UPDATE people SET link='p'").run()
  const linked = await snapshot()
  await apply(migration.sql)
  expect(await snapshot()).toEqual(linked)
})

it.each(['- 1', '-\t\n\f\r 1'])('accepts DEFAULT %j on first rebuild and linked replay', async expression => {
  const { from, to } = fixture()
  const original = createEntity('people', from.entities.people)
  const changed = original.replace('DEFAULT -1', `DEFAULT ${expression}`)
  expect(changed).not.toBe(original)
  await apply(initialSchema(from).replace(original, changed)); await seed()
  expect(await env.DB.prepare("SELECT dflt_value FROM pragma_table_xinfo('people') WHERE name='negative'").first('dflt_value')).toBe(expression)
  const before = await snapshot()
  expect(before.revisions.map(row => row.revision)).toEqual([1])
  expect(before.rows[0].negative).toBe(-1)
  const migration = plan(from, to)
  expect(migration.blocked).toEqual([])
  await apply(migration.sql)
  const rebuilt = await snapshot()
  expect(rebuilt.rows).toEqual(before.rows.map(row => ({ ...row, link: null })))
  expect(rebuilt.revisions.map(row => row.revision)).toEqual([1, 2])
  expect(rebuilt.revisions[0]).toEqual(before.revisions[0])
  expect(await env.DB.prepare("SELECT dflt_value FROM pragma_table_xinfo('people') WHERE name='negative'").first('dflt_value')).toBe('-1')
  const insert = (id: string) => env.DB.prepare("INSERT INTO people (id,organization_id,created_at,updated_at) VALUES (?,'org','created','updated')").bind(id).run()
  const defaults = (id: string) => env.DB.prepare('SELECT name,n,fraction,negative,link FROM people WHERE id=?').bind(id).first()
  const expectedDefaults = { name: nameDefault, n: 1, fraction: 0.5, negative: -1, link: null }
  await insert('after-apply')
  expect(await defaults('after-apply')).toEqual(expectedDefaults)
  await env.DB.prepare("UPDATE people SET link='p' WHERE id='p'").run()
  const linked = await snapshot()
  await apply(migration.sql)
  expect(await snapshot()).toEqual(linked)
  await insert('after-replay')
  expect(await defaults('after-replay')).toEqual(expectedDefaults)
})

it('accepts DEFAULT sign whitespace when the linked replay starts with the next physical shape', async () => {
  const { from, to } = fixture()
  const original = createEntity('people', to.entities.people)
  const changed = original.replace('DEFAULT -1', 'DEFAULT - 1')
  expect(changed).not.toBe(original)
  await apply(initialSchema(to).replace(original, changed)); await seed()
  await env.DB.prepare("UPDATE people SET link='p'").run()
  const before = await snapshot()
  expect(before.revisions.map(row => row.revision)).toEqual([2])
  const migration = plan(from, to)
  expect(migration.blocked).toEqual([])
  await apply(migration.sql)
  const after = await snapshot()
  expect(after.rows).toEqual(before.rows)
  expect(after.revisions).toEqual(before.revisions)
  expect(await env.DB.prepare("SELECT dflt_value FROM pragma_table_xinfo('people') WHERE name='negative'").first('dflt_value')).toBe('-1')
  await apply(migration.sql)
  expect(await snapshot()).toEqual(after)
})

it.each([
  ['changed literal', 'DEFAULT -1', 'DEFAULT 0', 'columns'],
  ['changed token kind', 'DEFAULT -1', "DEFAULT '-1'", 'columns'],
  ['parenthesized literal', 'DEFAULT -1', 'DEFAULT (-1)', 'inline_constraints'],
  ['arithmetic expression', 'DEFAULT -1', 'DEFAULT (-1 + 0)', 'columns'],
  ['numeric spelling', 'DEFAULT -1', 'DEFAULT -1.0', 'columns'],
  ['string contents', `DEFAULT ${literal(nameDefault)}`, `DEFAULT ${literal("Keep,(a 'quoted' value)")}`, 'columns'],
  ['string case', `DEFAULT ${literal(nameDefault)}`, `DEFAULT ${literal(nameDefault.toLowerCase())}`, 'columns'],
  ['no default versus NULL', '"parent" TEXT', '"parent" TEXT DEFAULT NULL', 'columns'],
] as const)('refuses DEFAULT drift with unchanged schema, data and revision: %s', async (_label, search, replacement, difference) => {
  const { from, to } = fixture()
  const original = createEntity('people', from.entities.people)
  const changed = original.replace(search, replacement)
  expect(changed).not.toBe(original)
  await apply(initialSchema(from).replace(original, changed)); await seed()
  const before = await snapshot()
  expect(before.revisions.map(row => row.revision)).toEqual([1])
  await expect(apply(plan(from, to).sql)).rejects.toThrow(new RegExp(`rebuild_requires_review_people_${difference}`))
  expect(await snapshot()).toEqual(before)
})

it.each(['column', 'index', 'foreign key', 'table', 'all identifiers'] as const)('accepts identifier case differences in %s metadata', async variant => {
  const { from, to } = fixture()
  const original = createEntity('people', from.entities.people)
  let changed = original
  if (variant === 'column') changed = changed.replaceAll('"name"', '"NAME"')
  if (variant === 'index') changed = changed.replaceAll('"people_org_idx"', '"PEOPLE_ORG_IDX"')
  if (variant === 'foreign key') changed = changed.replaceAll('REFERENCES "people"(organization_id, id)', 'REFERENCES "PEOPLE"(ORGANIZATION_ID, ID)')
  if (variant === 'table') changed = changed.replaceAll('"people"', '"PEOPLE"')
  if (variant === 'all identifiers') changed = changed.replaceAll(/"[a-z_]+"/g, identifier => identifier.toUpperCase())
  expect(changed).not.toBe(original)
  await apply(initialSchema(from).replace(original, changed)); await seed()
  const index = variant === 'index' || variant === 'all identifiers' ? 'PEOPLE_NAME_IDX' : 'people_name_idx'
  await env.DB.prepare(`CREATE INDEX ${index} ON people(organization_id, name)`).run()
  const migration = plan(from, to, { indexes: [{ entity: 'people', name: 'people_name_idx', fields: ['name'] }] })
  expect(migration.blocked).toEqual([])
  await apply(migration.sql)
  expect(await env.DB.prepare('SELECT name,link,n FROM people').first()).toEqual({ name: 'Person', link: null, n: 1 })
  await apply(migration.sql)
  expect(await env.DB.prepare('SELECT max(revision) n FROM instance_meta').first('n')).toBe(2)
  expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
})

it('refuses incoming actions even when the FK target uses different identifier case', async () => {
  const { from, to } = fixture()
  await apply(plan(null, from).sql); await seed()
  await env.DB.prepare('CREATE TABLE child (person TEXT REFERENCES PEOPLE(id) ON DELETE SET NULL)').run()
  const before = await snapshot()
  await expect(apply(plan(from, to).sql)).rejects.toThrow(/rebuild_requires_review_people_incoming_actions/)
  expect(await snapshot()).toEqual(before)
})

// Evaluate the actual guard's definition expression in D1, including lexical
// forms the numeric JS-to-SQL generator does not emit (hex and leading dots).
async function tokens() {
  const { from, to } = fixture()
  const expression = plan(from, to).sql.match(/'inline_constraints', ([\s\S]+?),\n    'triggers'/)![1]
  const definitions = JSON.parse((await env.DB.prepare(`SELECT ${expression} AS parts`).first<string>('parts'))!) as string[]
  return definitions.flatMap(definition => JSON.parse(`[${definition.slice(0, -1)}]`) as string[])
}

// Supply synthetic PRAGMA rows to the actual columns expression to exercise
// malformed defaults that SQLite's DDL parser would otherwise reject first.
async function defaultTokens(value: string | null) {
  const { from, to } = fixture()
  const expression = plan(from, to).sql.match(/'columns', ([\s\S]+?),\n    'indexes'/)![1]
    .replace("pragma_table_xinfo('people')", `(SELECT 'negative' AS name, 'INTEGER' AS type, 0 AS "notnull", ? AS dflt_value, 0 AS pk, 0 AS hidden)`)
  const columns = JSON.parse((await env.DB.prepare(`SELECT ${expression} AS columns`).bind(value).first<string>('columns'))!) as [string, string, number, string[] | null, number, number][]
  return columns[0][3]
}

it('normalizes only whitespace in default tokens and keeps absent defaults distinct', async () => {
  expect(await defaultTokens('- 1')).toEqual(await defaultTokens('-1'))
  expect(await defaultTokens(null)).toBeNull()
  expect(await defaultTokens('NULL')).not.toEqual(await defaultTokens(null))
  for (const [left, right] of [
    ['-1', '-1.0'], ['-1', "'-1'"], ['-1', '(-1)'], ['-1', '(-1 + 0)'],
    ['1e-7', '1E-7'], ['1', '0x1'], ['NULL', 'null'],
    ['"Value"', '"value"'], ['"Value"', '[Value]'], ['"Value"', "'Value'"],
    ["'One Two'", "'OneTwo'"], ["'One Two'", "'one two'"],
  ]) expect(await defaultTokens(left)).not.toEqual(await defaultTokens(right))
})

it.each(['', ' \t\n', '1e', '1e+', '0x', "'unterminated", '"unterminated', '(1', '1)', '1,2', '/* unknown */ 1', '1 -- comment', 'é'])(
  'fails closed on unclassified or incomplete default tokens: %j', async value => {
    expect(await defaultTokens(value)).toEqual([])
  },
)

it('distinguishes numeric, quoted identifier, bare word, string and punctuation tokens in D1', async () => {
  await env.DB.prepare(`CREATE TABLE people (n REAL CHECK (
    "n" >= 1e-7 AND n < 1e+21 AND n <> .5 AND n <> 0x1F AND n <> -1
    AND n <> 1. AND n <> 2E3 AND n <> "1e"-7 AND n <> '1e'-7))`).run()
  const actual = await tokens()
  expect(actual).toEqual(expect.arrayContaining([
    'n:1e-7', 'n:1e+21', 'n:.5', 'n:0x1F', 'n:1', 'n:1.', 'n:2E3', 'n:7',
    'i:1e', 'i:n', 'w:n', 'w:real', 's:1e', 'p:-',
  ]))
  expect(actual).not.toContain('p:.')
  expect(actual).not.toContain('w:1e')
})

it.each(['/* unfamiliar */', '-- unfamiliar\n', 'é'])('fails closed on unclassified DDL: %s', async extra => {
  await env.DB.prepare(`CREATE TABLE people (n REAL ${extra})`).run()
  expect(await tokens()).toEqual([])
})
