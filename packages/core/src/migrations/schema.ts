import { uniqueIndexName, refEqualityToken, refImmutableToken, type EntityConstraint, type UniqueConstraint, type RefEqualityConstraint, type RefImmutableConstraint } from '../entity-constraints'
import { systemSchema } from './system-schema'
export { systemSchema } from './system-schema'
import { workflowSchema } from '../workflow-schema'
import { opsSchema } from '../ops-schema'
import { betterAuthSchema } from './better-auth-schema'
import { emailDeliverySchema } from './email-delivery-schema'
import { CORE_VERSION, type Field, type InstanceConfig } from '../config'
import { usesSdkBaseline } from './reset-era'
export function quote(name: string) {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`Invalid SQL identifier: ${name}`)
  return `"${name}"`
}
export function literal(value: unknown): string {
  if (value === null) return 'NULL'
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`
  throw new Error('Unsupported SQL literal')
}
/** SQL-level data only. Runtime presentation and policy declarations never enter renderTable. */
export interface ColumnSpec {
  name: string; sqlType: string; notNull: boolean; defaultSql: string | null; checks: string[]
  implicit?: boolean; primaryKey?: boolean; references?: { table: string; column: string }
}
export interface TableSpec {
  constraints?: EntityConstraint[]
  name: string; columns: ColumnSpec[]; unique: string[][]; checks: string[]
  foreignKeys: { columns: string[]; table: string; targetColumns: string[] }[]
  indexes: { name: string; columns: string[] }[]
}
function physicalColumn(name: string, f: Field): ColumnSpec {
  const q = quote(name)
  return { name, sqlType: ['int', 'bool'].includes(f.type) ? 'INTEGER' : f.type === 'float' ? 'REAL' : 'TEXT',
    notNull: f.required, defaultSql: f.default === undefined ? null : literal(f.default),
    checks: [
      ...(f.type === 'enum' ? [`${q} IN (${f.values!.map(literal).join(', ')})`] : []),
      ...(f.type === 'bool' ? [`${q} IN (0,1)`] : []),
      ...(f.min !== undefined ? [`${q} >= ${literal(f.min)}`] : []),
    ],
  }
}
export function renderColumn(c: ColumnSpec) {
  return `${c.implicit ? c.name : quote(c.name)} ${c.sqlType}${c.primaryKey ? ' PRIMARY KEY' : ''}${c.notNull ? ' NOT NULL' : ''}${c.defaultSql !== null ? ` DEFAULT ${c.defaultSql}` : ''}${c.references ? ` REFERENCES ${c.references.table}(${c.references.column})` : ''}${c.checks.map(check => ` CHECK (${check})`).join('')}`
}
// Legacy adapters project before rendering; the renderer knows only SQL specs.
export function column(name: string, field: Field) { return renderColumn(physicalColumn(name, field)) }
export function physicalTable(name: string, entity: InstanceConfig['entities'][string]): TableSpec {
  const fields = Object.entries(entity.fields).filter(([, f]) => !f.computed)
  const refs = fields.filter(([, f]) => f.type === 'ref')
  const implicit = (name: string, sqlType: string, notNull = true, defaultSql: string | null = null): ColumnSpec =>
    ({ name, sqlType, notNull, defaultSql, checks: [], implicit: true })
  return { name, ...(entity.constraints?.length ? { constraints: [...entity.constraints].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) } : {}), columns: [
    { ...implicit('id', 'TEXT', false), primaryKey: true },
    { ...implicit('organization_id', 'TEXT'), references: { table: 'organizations', column: 'id' } },
    implicit('created_at', 'TEXT'), implicit('updated_at', 'TEXT'), implicit('version', 'INTEGER', true, '1'),
    ...fields.map(([key, field]) => physicalColumn(key, field)),
  ], unique: [['organization_id', 'id']],
    checks: entity.checks.map(c => `${quote(c.left)} ${c.op} ${quote(c.right)}`),
    foreignKeys: refs.map(([key, f]) => ({ columns: ['organization_id', key], table: f.entity!, targetColumns: ['organization_id', 'id'] })),
    indexes: [{ name: `${name}_org_idx`, columns: ['organization_id', 'id'] }, ...refs.map(([key]) => ({ name: `${name}_${key}_idx`, columns: ['organization_id', key] }))],
  }
}
export function renderUniqueConstraint(table: string, constraint: UniqueConstraint) {
  return `CREATE UNIQUE INDEX ${quote(uniqueIndexName(table, constraint.name))} ON ${quote(table)}(${['organization_id', ...constraint.fields].map(quote).join(', ')})${constraint.where ? ` WHERE ${quote(constraint.where.field)} = ${literal(constraint.where.value)}` : ''};`
}
export function renderTable(table: TableSpec) {
  const q = (name: string) => table.columns.find(c => c.name === name)?.implicit ? name : quote(name)
  const columns = [
    ...table.columns.map(renderColumn), ...table.unique.map(keys => `UNIQUE (${keys.map(q).join(', ')})`),
    ...table.foreignKeys.map(f => `FOREIGN KEY (${f.columns.map(q).join(', ')}) REFERENCES ${quote(f.table)}(${f.targetColumns.join(', ')})`),
    ...table.checks.map(check => `CHECK (${check})`),
  ]
  const indexes = table.indexes.map(index => `CREATE INDEX ${quote(index.name)} ON ${quote(table.name)}(${index.columns.map(q).join(', ')});`)
  return `CREATE TABLE ${quote(table.name)} (\n  ${columns.join(',\n  ')}\n);\n${indexes[0]}\n${indexes.slice(1).join('\n')}${table.constraints?.some(c => c.kind === 'unique') ? '\n' + table.constraints.filter(c => c.kind === 'unique').map(c => renderUniqueConstraint(table.name, c)).join('\n') : ''}`
}
export function createEntity(name: string, entity: InstanceConfig['entities'][string]) { return renderTable(physicalTable(name, entity)) }

/** New tables have canonical order; existing columns retain the base's physical order. */
export function physicalTables(config: Pick<InstanceConfig, 'entities' | 'account'>, base: readonly TableSpec[] = []): TableSpec[] {
  return Object.entries(config.entities).filter(([name]) => name !== config.account?.entity).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, entity]) => {
    const table = physicalTable(name, { ...entity, fields: Object.fromEntries(Object.entries(entity.fields).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) })
    const previous = base.find(t => t.name === name)
    if (previous) {
      const names = previous.columns.map(c => c.name)
      table.columns = [...names.flatMap(name => table.columns.filter(c => c.name === name)), ...table.columns.filter(c => !names.includes(c.name))]
    }
    return table
  })
}

export const revisionSQL = (revision: number) => `INSERT INTO instance_meta VALUES (${revision}, '${CORE_VERSION}', strftime('%Y-%m-%dT%H:%M:%fZ','now'));`
// Revisions are the primary key: preserve older rows and refresh only the current
// revision's SDK stamp after deploy-time migration verification succeeds.
export const coreVersionSQL = (revision: number) => `UPDATE instance_meta SET core_version = ${literal(CORE_VERSION)}, applied_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE revision = ${literal(revision)} AND revision = (SELECT MAX(revision) FROM instance_meta) AND core_version <> ${literal(CORE_VERSION)};`
/** New-era Instance SQL owns domain tables only.
 * Preserve the inline defineInstance baseline until its consumers are retired. */
export function initialSchema(config: InstanceConfig) {
  const legacy = !usesSdkBaseline(config)
    ? configuredSystemSchema(config) + opsSchema + (config.account?.entity === 'users' ? betterAuthSchema.replace('user_id TEXT NOT NULL REFERENCES users(id)', 'user_id TEXT NOT NULL REFERENCES "user"(id)') : betterAuthSchema) + emailDeliverySchema + workflowSchema
    : ''
  if (usesSdkBaseline(config)) return physicalTables(config).map(renderTable).join('\n') + renderConstraintTriggers(physicalTables(config)) + '\n'
  return legacy + Object.entries(config.entities).filter(([n]) => !(n === 'users' && config.account?.entity === n)).map(([n, e]) => createEntity(n, e)).join('\n') + renderConstraintTriggers(physicalTables(config)) + '\n' + revisionSQL(config.revision) + '\n'
}

/** Fresh schemas support configured application roles and the explicit users/account extension.
 * Existing installations keep their append-only migration chain. */
function configuredSystemSchema(config: InstanceConfig) {
  let sql = systemSchema.replace(/ CHECK ?\(role IN \('owner','dispatcher','viewer'\)\)/g, '')
  if (config.account?.entity === 'users') {
    const domain = createEntity('users', config.entities.users)
      .replace('id TEXT PRIMARY KEY,', "id TEXT PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT NOT NULL DEFAULT '', salt TEXT NOT NULL DEFAULT '',")
    sql = sql.replace(/CREATE TABLE users \([^;]+;/, domain)
      .replace("INSERT INTO identities (user_id,provider,issuer,subject,created_at) SELECT id,'local','local',id,created_at FROM users;", '')
      .replace('CREATE TABLE identities (\n  user_id TEXT NOT NULL REFERENCES users(id)', 'CREATE TABLE identities (\n  user_id TEXT NOT NULL REFERENCES "user"(id)')
  }
  return sql
}

/** Null equals null. A null hop projects null; a non-null hop must resolve in the
 * same organization. Missing/foreign refs never pass, and composite FKs remain.
 * The reverse guard preserves equality, not slice 4's stricter immutability. */
export function refEqualityDefinition(table: TableSpec, constraint: RefEqualityConstraint) {
  const target = table.foreignKeys.find(f => f.columns.length === 2 && f.columns[0] === 'organization_id' && f.columns[1] === constraint.through)!.table
  const token = refEqualityToken(table.name, constraint.name)
  const source = quote(table.name), parent = quote(target)
  const field = quote(constraint.field), hop = quote(constraint.through), targetField = quote(constraint.targetField)
  const mismatch = (row: string) => `(${row}.${hop} IS NULL AND ${row}.${field} IS NOT NULL) OR (${row}.${hop} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${parent} AS target WHERE target."organization_id" = ${row}."organization_id" AND target."id" = ${row}.${hop} AND target.${targetField} IS ${row}.${field}))`
  const reverseMismatch = (row: string) => `EXISTS (SELECT 1 FROM ${source} AS source WHERE source."organization_id" = ${row}."organization_id" AND source.${hop} = ${row}."id" AND source.${field} IS NOT NEW.${targetField})`
  const abort = `SELECT RAISE(ABORT, ${literal(token)});`
  const triggers = [
    { name: `${token}_insert`, sql: `CREATE TRIGGER ${quote(`${token}_insert`)} AFTER INSERT ON ${source} WHEN ${mismatch('NEW')} BEGIN ${abort} END;` },
    { name: `${token}_update`, sql: `CREATE TRIGGER ${quote(`${token}_update`)} AFTER UPDATE OF ${field}, ${hop}, "organization_id" ON ${source} WHEN ${mismatch('NEW')} BEGIN ${abort} END;` },
    { name: `${token}_reverse`, sql: `CREATE TRIGGER ${quote(`${token}_reverse`)} AFTER UPDATE OF ${targetField} ON ${parent} WHEN NEW.${targetField} IS NOT OLD.${targetField} AND ${reverseMismatch('OLD')} BEGIN ${abort} END;` },
    // INSERT OR REPLACE can change a target field without firing UPDATE. The
    // distinct single-word role suffix keeps the global trigger names injective.
    { name: `${token}_replace`, sql: `CREATE TRIGGER ${quote(`${token}_replace`)} AFTER INSERT ON ${parent} WHEN ${reverseMismatch('NEW')} BEGIN ${abort} END;` },
  ]
  // CHECK preflight reads existing data without touching domain or audit rows.
  const guard = quote(`${token}_guard`)
  const preflight = `CREATE TABLE ${guard} ("valid" INTEGER CONSTRAINT ${quote(token)} CHECK ("valid" = 1));
INSERT INTO ${guard} SELECT 0 FROM ${source} AS source WHERE ${mismatch('source')} LIMIT 1;
DROP TABLE ${guard};`
  return { token, target, triggers, preflight }
}
/** The stored ref `field` of the constrained table cannot change while a same-organization
 * row of `referencedBy` points at the row. `IS NOT` makes NULL<->value changes
 * rejected and same-value/NULL->NULL updates allowed; there is no status filter.
 * Both triggers are BEFORE triggers, so they always fire ahead of slice 3's AFTER
 * equality guards: when both reject, the stricter immutability token is the one raised.
 * A plain INSERT whose primary key already exists with a different field value is
 * also reported here while referenced (the row is only reachable through REPLACE
 * or upsert); an upsert that never writes the field is likewise rejected. */
export function refImmutableDefinition(table: TableSpec, constraint: RefImmutableConstraint) {
  const token = refImmutableToken(table.name, constraint.name)
  const self = quote(table.name), source = quote(constraint.referencedBy.entity)
  const field = quote(constraint.field), hop = quote(constraint.referencedBy.field)
  const referenced = (row: string) => `EXISTS (SELECT 1 FROM ${source} AS referrer WHERE referrer."organization_id" = ${row}."organization_id" AND referrer.${hop} = ${row}."id")`
  const abort = `SELECT RAISE(ABORT, ${literal(token)});`
  const triggers = [
    { name: `${token}_update`, sql: `CREATE TRIGGER ${quote(`${token}_update`)} BEFORE UPDATE OF ${field} ON ${self} WHEN NEW.${field} IS NOT OLD.${field} AND ${referenced('OLD')} BEGIN ${abort} END;` },
    { name: `${token}_replace`, sql: `CREATE TRIGGER ${quote(`${token}_replace`)} BEFORE INSERT ON ${self} WHEN EXISTS (SELECT 1 FROM ${self} AS previous WHERE previous."id" = NEW."id" AND previous.${field} IS NOT NEW.${field} AND ${referenced('previous')}) BEGIN ${abort} END;` },
  ]
  return { token, triggers }
}
/** Trigger-backed constraints install after every table exists; unique indexes are rendered inline. */
export function constraintTriggers(table: TableSpec, constraint: EntityConstraint): { preflight?: string; triggers: { name: string; sql: string }[] } {
  return constraint.kind === 'ref_equality' ? refEqualityDefinition(table, constraint) : constraint.kind === 'ref_immutable' ? refImmutableDefinition(table, constraint) : { triggers: [] }
}
export function renderConstraintTriggers(tables: readonly TableSpec[]) {
  const sql = tables.flatMap(table => (table.constraints ?? []).flatMap(c => constraintTriggers(table, c).triggers.map(t => t.sql)))
  return sql.length ? '\n' + sql.join('\n') : ''
}
export function dropConstraint(table: TableSpec, constraint: EntityConstraint) {
  return constraint.kind === 'unique' ? `DROP INDEX ${quote(uniqueIndexName(table.name, constraint.name))};`
    : constraintTriggers(table, constraint).triggers.map(t => `DROP TRIGGER ${quote(t.name)};`).join('\n')
}
