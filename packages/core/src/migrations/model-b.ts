import type { InstanceConfig } from '../config'
import type { PluginMigration } from '../kernel/plugin'
import { accountRoleValue } from '../account-provisioning'
import { MigrationDiagnostic } from './diagnostics'
import { literal } from './schema'

// Identifiers originate in the live SQLite catalog, including plugin-owned names.
const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`

/** Token positions keep quoted strings/comments and unrelated CHECKs byte-for-byte. */
export function withoutRoleChecks(sql: string): string {
  const lexical = [...sql.matchAll(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[a-z_][a-z_0-9]*|[^\s]/gi)]
  const comments = lexical.filter(token => token[0].startsWith('--') || token[0].startsWith('/*'))
  const tokens = lexical.filter(token => !comments.includes(token))
  const word = (i: number) => tokens[i]?.[0].replace(/^["`\[]|["`\]]$/g, '').toLowerCase()
  const removals: [number, number][] = []
  const precedingSeparators = new Map<number, number>()
  let depth = 0; let segment = 0
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token[0] === '(') { depth++; if (depth === 1) segment = i + 1 }
    if (token[0] === ')') depth--
    if (token[0] === ',' && depth === 1) segment = i + 1
    if (word(i) !== 'check' || word(i + 1) !== '(' || word(i + 2) !== 'role' || word(i + 3) !== 'in' || word(i + 4) !== '(') continue
    let end = i + 5
    while (/^'(?:''|[^'])*'$/.test(tokens[end]?.[0] ?? '')) {
      end++
      if (tokens[end]?.[0] !== ',') break
      end++
    }
    if (word(end) !== ')' || word(end + 1) !== ')') continue
    const start = word(i - 2) === 'constraint' ? i - 2 : i
    end++
    // SQLite accepts a conflict clause on table CHECKs. It belongs to the
    // removed constraint; leaving it behind can change a preceding UNIQUE.
    if (start === segment && /^on$/i.test(tokens[end + 1]?.[0] ?? '') && /^conflict$/i.test(tokens[end + 2]?.[0] ?? '') && /^(rollback|abort|fail|ignore|replace)$/i.test(tokens[end + 3]?.[0] ?? '')) end += 3
    // Remove the separator independently: intervening comments/newlines belong
    // to the schema, not to this constraint. Adjacent matches may share it.
    if (start === segment) {
      let separator = start - 1
      if (tokens[end + 1]?.[0] === ',') {
        separator = end + 1
        precedingSeparators.set(separator, start - 1)
      } else {
        // Earlier adjacent CHECKs already own the intervening commas. The
        // final one owns the comma before that entire run.
        while (precedingSeparators.has(separator)) separator = precedingSeparators.get(separator)!
      }
      removals.push([tokens[separator].index!, tokens[separator].index! + 1])
    }
    let from = tokens[start].index!
    while (from > 0 && /[^\S\r\n]/.test(sql[from - 1])) from--
    removals.push([from, tokens[end].index! + tokens[end][0].length])
    i = end
  }
  // Never consume a comment, even when it occurs inside a matched constraint.
  const spans: [number, number][] = []
  for (const [start, end] of removals) {
    let from = start
    for (const comment of comments) {
      const left = comment.index!
      const right = left + comment[0].length + (comment[0].startsWith('--') && sql[left + comment[0].length] === '\n' ? 1 : 0)
      if (right <= from || left >= end) continue
      if (from < left) spans.push([from, left])
      from = right
    }
    if (from < end) spans.push([from, end])
  }
  const merged: [number, number][] = []
  for (const [start, end] of spans.sort((a, b) => a[0] - b[0])) {
    const previous = merged.at(-1)
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end)
    else merged.push([start, end])
  }
  for (const [start, end] of merged.reverse()) sql = sql.slice(0, start) + sql.slice(end)
  return sql
}

async function backfill(db: D1Database, config?: InstanceConfig): Promise<string[]> {
  if (config?.account?.entity !== 'users') return []
  const multiple = await db.prepare('SELECT user_id FROM memberships GROUP BY user_id HAVING count(DISTINCT organization_id)>1 ORDER BY user_id').all<{ user_id: string }>()
  if (multiple.results.length) throw new MigrationDiagnostic({ code: 'migration_blocked', reason: 'multiple_organizations', userIds: multiple.results.map(row => row.user_id) })
  const misplaced = await db.prepare('SELECT DISTINCT m.user_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.organization_id<>m.organization_id ORDER BY m.user_id').all<{ user_id: string }>()
  if (misplaced.results.length) throw new MigrationDiagnostic({ code: 'migration_blocked', reason: 'account_organization_mismatch', userIds: misplaced.results.map(row => row.user_id) })
  const { results: columns } = await db.prepare('SELECT name FROM pragma_table_info(\'memberships\')').all<{ name: string }>()
  const hasCreatedAt = columns.some(column => column.name === 'created_at')
  const { results: missing } = await db.prepare(`SELECT m.user_id,m.organization_id,m.role,${hasCreatedAt ? 'm.created_at' : 'NULL'} AS created_at,u.email,u.name FROM memberships m LEFT JOIN "user" u ON u.id=m.user_id WHERE NOT EXISTS (SELECT 1 FROM users a WHERE a.id=m.user_id AND a.organization_id=m.organization_id) ORDER BY m.user_id`).all<{ user_id: string; organization_id: string; role: string; created_at: string | null; email: string | null; name: string | null }>()
  const statements: string[] = []
  const blocked = new Map<string, Set<string>>()
  const block = (field: string, userId: string) => { const ids = blocked.get(field) ?? new Set<string>(); ids.add(userId); blocked.set(field, ids) }
  for (const row of missing) {
    const values: Record<string, string | number | boolean | null> = { id: row.user_id, organization_id: row.organization_id, email: row.email, password_hash: '', salt: '', version: 1, name: row.name ?? row.user_id }
    if (!config.entities.users.fields.name) delete values.name
    try {
      const role = accountRoleValue(config, row.role)
      if (role !== undefined) values.role = role
    } catch { block('role', row.user_id) }
    for (const [field, definition] of Object.entries(config.entities.users.fields)) {
      if (definition.computed) { delete values[field]; continue }
      if (Object.hasOwn(values, field)) continue
      if (definition.default !== undefined) values[field] = definition.default
      else if (definition.required) block(field, row.user_id)
    }
    const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
    const timestamps = { created_at: row.created_at ? literal(row.created_at) : now, updated_at: now }
    statements.push(`INSERT INTO users (${[...Object.keys(values), ...Object.keys(timestamps)].map(identifier).join(',')}) SELECT ${[...Object.values(values).map(literal), ...Object.values(timestamps)].join(',')} WHERE NOT EXISTS (SELECT 1 FROM users WHERE id=${literal(row.user_id)} AND organization_id=${literal(row.organization_id)})`)
  }
  for (const [field, userIds] of blocked) throw new MigrationDiagnostic({ code: 'migration_blocked', reason: 'required_account_field', field, userIds: [...userIds] })
  return statements
}

// Keep rebuild.ts's incoming_actions predicate: deferred checks cannot prevent
// CASCADE/SET NULL, and RESTRICT still checks immediately.
const incomingActions = (table: string) => `SELECT DISTINCT s.name FROM sqlite_schema s, pragma_foreign_key_list(s.name) fk WHERE s.type = 'table' AND s.name NOT GLOB '_cf_*' AND s.name NOT GLOB 'sqlite_*' AND lower(fk."table") = lower(${literal(table)}) AND (fk.on_delete <> 'NO ACTION' OR fk.on_update <> 'NO ACTION')`

export function coreMigrations(config?: InstanceConfig): readonly PluginMigration[] {
  return [{ name: '001_model_b', sql: '-- Model B v1: preserve live role tables; backfill configured users accounts', async statements(db) {
    const statements = await backfill(db, config)
    const witnesses: string[] = []
    const guard = 'workbase_model_b_guard'
    for (const table of ['memberships', 'invitations', 'access_tokens']) {
      const master = await db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=${literal(table)}`).first<{ sql: string }>()
      if (!master) continue
      const sql = withoutRoleChecks(master.sql)
      if (sql === master.sql) continue
      const incoming = incomingActions(table)
      const { results: referencing } = await db.prepare(`${incoming} ORDER BY s.name`).all<{ name: string }>()
      if (referencing.length) throw new MigrationDiagnostic({ code: 'migration_blocked', reason: 'incoming_foreign_key_actions', table, referencingTables: referencing.map(row => row.name) })
      witnesses.push(`INSERT INTO ${guard} (ok) SELECT NOT EXISTS (${incoming})`)
      const { results: columns } = await db.prepare(`SELECT name FROM pragma_table_info(${literal(table)})`).all<{ name: string }>()
      const { results: objects } = await db.prepare(`SELECT sql FROM sqlite_master WHERE tbl_name=${literal(table)} AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name`).all<{ sql: string }>()
      witnesses.push(`INSERT INTO ${guard} (ok) SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name=${literal(table)} AND sql=${literal(master.sql)}) AND (SELECT json_group_array(sql) FROM (SELECT sql FROM sqlite_master WHERE tbl_name=${literal(table)} AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name))=${literal(JSON.stringify(objects.map(object => object.sql)))}`)
      const fields = columns.map(column => identifier(column.name)).join(',')
      const rows = identifier(`workbase_model_b_${table}_rows`)
      statements.push(`CREATE TABLE ${rows} AS SELECT ${fields} FROM ${identifier(table)}`, `DROP TABLE ${identifier(table)}`, sql,
        `INSERT INTO ${identifier(table)} (${fields}) SELECT ${fields} FROM ${rows}`, ...objects.map(object => object.sql), `DROP TABLE ${rows}`)
    }
    if (!statements.length) return []
    // Like rebuild.ts: defer the graph, guard the final FK check in SQL, clean up
    // before the ledger receipt. Failure rolls back DDL, rows and receipt together.
    const accounts = config?.account?.entity === 'users' ? [`INSERT INTO ${guard} (ok) SELECT NOT EXISTS (SELECT user_id FROM memberships GROUP BY user_id HAVING count(DISTINCT organization_id)>1) AND NOT EXISTS (SELECT 1 FROM memberships m WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id=m.user_id AND u.organization_id=m.organization_id))`] : []
    return [`CREATE TABLE ${guard} (ok INTEGER CONSTRAINT rebuild_requires_review CHECK (ok = 1))`, 'PRAGMA defer_foreign_keys = ON', ...witnesses, ...statements, ...accounts,
      `INSERT INTO ${guard} (ok) SELECT NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check)`, `DROP TABLE ${guard}`, 'PRAGMA defer_foreign_keys = OFF']
  } }]
}
