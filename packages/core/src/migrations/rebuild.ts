import type { InstanceConfig } from '../config'
import { createEntity, literal, quote } from './schema'

/** Non-unique, organization-scoped indexes owned by the caller (e.g. configuration MCP). */
export interface SupplementalIndex { entity: string; name: string; fields: string[] }

const differences = ['rowid', 'columns', 'indexes', 'foreign_keys', 'inline_constraints', 'triggers', 'incoming_actions'] as const

/** Canonical multiset of top-level definitions. Token boundaries and string
 * contents survive normalization. Quoted identifiers (i), bare words (w),
 * numbers (n), strings (s) and punctuation (p) remain distinct. Only whitespace,
 * identifier quote style/case and definition order are ignored. Numeric states
 * consume decimal/hex digits and signed exponents without swallowing operators.
 * Comments, unknown characters, incomplete tokens and table suffixes fail closed.
 */
function definitions(table: string) {
  const ch = 'substr(body, pos, 1)', next = 'substr(body, pos + 1, 1)'
  const word = `${ch} GLOB '[a-zA-Z0-9_$]'`
  const digit = `${ch} GLOB '[0-9]'`
  const number = `mode IN ('integer', 'fraction', 'exponent', 'sign', 'digits', 'hex_start', 'hex')`
  const numberEnd = `mode IN ('integer', 'fraction', 'digits', 'hex')`
  const numberMore = `(${digit} AND mode IN ('integer', 'fraction', 'exponent', 'sign', 'digits'))
    OR (${ch} GLOB '[0-9a-fA-F]' AND mode IN ('hex_start', 'hex'))
    OR (${ch} = '.' AND mode = 'integer')
    OR (${ch} IN ('e', 'E') AND mode IN ('integer', 'fraction'))
    OR (${ch} IN ('+', '-') AND mode = 'exponent')
    OR (${ch} IN ('x', 'X') AND mode = 'integer' AND token = '0')`
  const flush = `(mode = 'word' AND NOT (${word})) OR
    (${numberEnd} AND NOT (${numberMore}) AND NOT (${word}) AND ${ch} <> '.')`
  const quoted = `mode IN (${["'", '"', '`', ']'].map(literal).join(', ')})`
  const closing = `${quoted} AND ${ch} = mode`
  const escaped = `${closing} AND ${next} = mode`
  const boundary = `mode = '' AND depth = 0 AND ${ch} IN (',', ')')`
  const space = `${ch} IN (' ', char(9), char(10), char(12), char(13))`
  const opening = `${ch} IN (${["'", '"', '`', '['].map(literal).join(', ')})`
  const punctuation = `${ch} IN (${[...'(),.+-*/%<>=~&|!'].map(literal).join(', ')})`
  return `(WITH RECURSIVE source(body) AS (
    SELECT substr(sql, instr(sql, '(') + 1) FROM sqlite_schema WHERE type = 'table' AND lower(name) = lower(${table})
  ), scan(pos, depth, mode, token, definition, parts) AS (
    SELECT 1, 0, '', '', '', json_array()
    UNION ALL
    SELECT pos + CASE WHEN ${flush} THEN 0 WHEN ${escaped} THEN 2 ELSE 1 END,
      depth + CASE WHEN mode = '' AND ${ch} = '(' THEN 1 WHEN mode = '' AND ${ch} = ')' AND depth > 0 THEN -1 ELSE 0 END,
      CASE WHEN ${flush} THEN ''
        WHEN ${number} THEN CASE
          WHEN NOT (${numberMore}) THEN 'invalid'
          WHEN mode IN ('hex_start', 'hex') THEN 'hex'
          WHEN ${ch} IN ('x', 'X') THEN 'hex_start'
          WHEN ${ch} IN ('e', 'E') THEN 'exponent'
          WHEN ${ch} IN ('+', '-') THEN 'sign'
          WHEN mode IN ('exponent', 'sign', 'digits') THEN 'digits'
          WHEN ${ch} = '.' THEN 'fraction' ELSE mode END
        WHEN ${quoted} THEN CASE WHEN ${closing} AND NOT (${escaped}) THEN '' ELSE mode END
        WHEN mode = 'word' THEN 'word'
        WHEN ${boundary} AND ${ch} = ')' THEN 'done'
        WHEN ${opening} THEN CASE WHEN ${ch} = '[' THEN ']' ELSE ${ch} END
        WHEN ${digit} THEN 'integer'
        WHEN ${ch} = '.' AND ${next} GLOB '[0-9]' THEN 'fraction'
        WHEN ${word} THEN 'word'
        WHEN (${ch} = '-' AND ${next} = '-') OR (${ch} = '/' AND ${next} = '*') THEN 'invalid'
        WHEN (${punctuation}) OR (${space}) THEN '' ELSE 'invalid' END,
      CASE WHEN ${flush} THEN ''
        WHEN ${number} THEN token || ${ch}
        WHEN ${quoted} THEN CASE WHEN ${closing} AND NOT (${escaped}) THEN '' ELSE token || ${ch} END
        WHEN (${word}) OR (${ch} = '.' AND ${next} GLOB '[0-9]') THEN token || ${ch} ELSE '' END,
      CASE WHEN ${flush} THEN definition || json_quote(CASE WHEN mode = 'word' THEN 'w:' || lower(token) ELSE 'n:' || token END) || ','
        WHEN ${number} THEN definition
        WHEN ${quoted} THEN CASE WHEN ${closing} AND NOT (${escaped})
          THEN definition || json_quote(CASE WHEN mode = ${literal("'")} THEN 's:' || token ELSE 'i:' || lower(token) END) || ',' ELSE definition END
        WHEN ${boundary} THEN ''
        WHEN ${opening} OR (${word}) OR (${space}) OR (${ch} = '.' AND ${next} GLOB '[0-9]') THEN definition
        ELSE definition || json_quote('p:' || ${ch}) || ',' END,
      CASE WHEN ${boundary} THEN json_insert(parts, '$[#]', definition) ELSE parts END
    FROM scan, source WHERE mode NOT IN ('done', 'invalid') AND pos <= length(body)
  ) SELECT json_group_array(value) FROM (
    SELECT value FROM scan, source, json_each(parts)
    WHERE mode = 'done' AND trim(substr(body, pos), ' ' || char(9) || char(10) || char(12) || char(13)) = '' ORDER BY value
  ))`
}

/** Use SQLite itself to describe both the physical table and a generator-built
 * witness. Keep automatic indexes and auxiliary index columns in the fingerprint.
 * Compare ASCII-case-folded identifiers rather than history-dependent column/FK
 * IDs. Preserve default expressions and string/numeric literal contents exactly.
 * Body tokens cover CHECK, COLLATE, conflict clauses and FK deferrability, which
 * PRAGMAs do not expose, so unfamiliar DDL still fails closed.
 */
function fingerprint(name: string, indexNames: [string, string][] = []) {
  const table = literal(name)
  const indexName = indexNames.length ? `CASE lower(name) ${indexNames.map(([physical, canonical]) => `WHEN lower(${literal(physical)}) THEN lower(${literal(canonical)})`).join(' ')} ELSE lower(name) END` : 'lower(name)'
  return `json_object(
    'rowid', (SELECT wr FROM pragma_table_list WHERE schema = 'main' AND lower(name) = lower(${table})),
    'columns', (SELECT json_group_array(json_array(lower(name), lower(type), "notnull", dflt_value, pk, hidden)) FROM (SELECT * FROM pragma_table_xinfo(${table}) ORDER BY lower(name))),
    'indexes', (SELECT json_group_array(json_array(index_name, origin, "unique", partial, json(columns))) FROM (
      SELECT CASE WHEN origin = 'c' THEN ${indexName} ELSE origin END AS index_name, origin, "unique", partial,
        (SELECT json_group_array(json_array(seqno, CASE WHEN cid < 0 THEN cid END, lower(name), "desc", lower(coll), "key")) FROM (SELECT * FROM pragma_index_xinfo(i.name) ORDER BY seqno)) AS columns
      FROM pragma_index_list(${table}) i ORDER BY index_name, columns)),
    'foreign_keys', (SELECT json_group_array(json_array("table", on_update, on_delete, match, json(columns))) FROM (
      SELECT lower("table") AS "table", on_update, on_delete, match,
        (SELECT json_group_array(json_array(seq, lower("from"), lower("to"))) FROM (SELECT * FROM pragma_foreign_key_list(${table}) WHERE id = fk.id ORDER BY seq)) AS columns
      FROM pragma_foreign_key_list(${table}) fk WHERE seq = 0 ORDER BY "table", on_update, on_delete, match, columns)),
    'inline_constraints', ${definitions(table)},
    'triggers', (SELECT count(*) FROM sqlite_schema WHERE type = 'trigger' AND lower(tbl_name) = lower(${table})),
    'incoming_actions', NOT EXISTS (SELECT 1 FROM sqlite_schema s, pragma_foreign_key_list(s.name) fk WHERE s.type = 'table' AND s.name NOT GLOB '_cf_*' AND s.name NOT GLOB 'sqlite_*' AND lower(fk."table") = lower(${table}) AND (fk.on_delete <> 'NO ACTION' OR fk.on_update <> 'NO ACTION'))
  )`
}

function witness(name: string, expected: string, entity: InstanceConfig['entities'][string], indexes: SupplementalIndex[]) {
  const suffixes = ['org_idx', ...Object.entries(entity.fields).filter(([, f]) => f.type === 'ref' && !f.computed).map(([key]) => `${key}_idx`)]
  const names: [string, string][] = [...suffixes.map(suffix => [`${expected}_${suffix}`, `${name}_${suffix}`] as [string, string]), ...indexes.map((index, i) => [`${expected}_supplemental_${i}`, index.name] as [string, string])]
  return { shape: fingerprint(expected, names), sql: createEntity(expected, entity)
    + '\n' + indexes.map((index, i) => `CREATE INDEX ${quote(`${expected}_supplemental_${i}`)} ON ${quote(expected)} (${['organization_id', ...index.fields].map(quote).join(', ')});`).join('\n')
  }
}

/** The runner must submit the whole migration in one D1 transaction/batch.
 * D1 cannot disable foreign_keys inside that transaction. Defer NO ACTION checks,
 * recreate the original name, validate the final graph, then restore enforcement.
 */
export function rebuildWithNullableRefs(name: string, previous: InstanceConfig, config: InstanceConfig, added: string[], indexes: SupplementalIndex[]) {
  const entity = config.entities[name]
  let prefix = `workbase_rebuild_${name}_${config.revision}`
  while (['rows', 'guard', 'previous', 'next'].some(suffix => config.entities[`${prefix}_${suffix}`] || previous.entities[`${prefix}_${suffix}`])) prefix += '_'
  const rows = quote(`${prefix}_rows`), guard = quote(`${prefix}_guard`), table = quote(name)
  const fields = Object.entries(entity.fields).filter(([, field]) => !field.computed)
  const columns = ['id', 'organization_id', 'created_at', 'updated_at', 'version', ...fields.map(([key]) => key)]
  const supplemental = indexes.filter(index => index.entity === name)
  const before = `${prefix}_previous`, after = `${prefix}_next`
  const previousIndexes = supplemental.map(index => ({ ...index, fields: index.fields.map(key => previous.entities[name].fields[key] ? key : entity.fields[key]?.renameFrom ?? key) }))
  const previousWitness = witness(name, before, previous.entities[name], previousIndexes)
  const nextWitness = witness(name, after, entity, supplemental)
  const guardSQL = `-- Verify ${name} against fresh generator shapes before any schema changes.
${previousWitness.sql}
${nextWitness.sql}
CREATE TABLE ${guard} (
  reason TEXT DEFAULT '' ${differences.map(part => `CONSTRAINT ${quote(`rebuild_requires_review_${name}_${part}`)} CHECK (reason <> ${literal(part)})`).join(' ')},
  ok INTEGER CONSTRAINT rebuild_requires_review CHECK (ok = 1)
);
WITH actual(shape) AS (SELECT ${fingerprint(name)}),
expected(shape) AS (SELECT CASE WHEN EXISTS (SELECT 1 FROM instance_meta WHERE revision = ${config.revision})
  THEN ${nextWitness.shape} ELSE ${previousWitness.shape} END)
INSERT INTO ${guard} (reason, ok) SELECT
  CASE ${differences.map(part => `WHEN json_extract(actual.shape, '$.${part}') IS NOT json_extract(expected.shape, '$.${part}') THEN ${literal(part)}`).join('\n    ')} ELSE '' END,
  actual.shape = expected.shape FROM actual, expected;
DROP TABLE ${quote(before)};
DROP TABLE ${quote(after)};`
  // SELECT * comes first deliberately: SQLite keeps its existing column when a
  // fallback alias duplicates it. First apply supplies NULL/default; a replay
  // copies the already-added reference, including links written since apply.
  const fallbacks = added.map(key => `${literal(entity.fields[key].default ?? null)} AS ${quote(key)}`).join(', ')
  return { guard: guardSQL, sql: `-- Rebuild ${name} atomically; physical schema differences require a manually reviewed migration.
CREATE TABLE ${rows} AS SELECT ${columns.map(quote).join(', ')} FROM (SELECT *, ${fallbacks} FROM ${table});
DROP TABLE ${table};
${createEntity(name, entity)}
${supplemental.map(index => `CREATE INDEX ${quote(index.name)} ON ${table} (${['organization_id', ...index.fields].map(quote).join(', ')});`).join('\n')}
INSERT INTO ${table} (${columns.map(quote).join(', ')}) SELECT ${columns.map(quote).join(', ')} FROM ${rows};
DROP TABLE ${rows};`, check: `INSERT INTO ${guard} (ok) SELECT NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check);`, cleanup: `DROP TABLE ${guard};` }
}
