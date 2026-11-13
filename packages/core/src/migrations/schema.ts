import { systemSchema } from './system-schema'
export { systemSchema } from './system-schema'
import { workflowSchema } from '../workflow-schema'
import { opsSchema } from '../ops-schema'
import { betterAuthSchema } from './better-auth-schema'
import { emailDeliverySchema } from './email-delivery-schema'
import { CORE_VERSION, type Field, type InstanceConfig } from '../config'
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
export function column(name: string, f: Field) {
  const q = quote(name)
  const type = ['int', 'bool'].includes(f.type) ? 'INTEGER' : f.type === 'float' ? 'REAL' : 'TEXT'
  return `${q} ${type}${f.required ? ' NOT NULL' : ''}${f.default !== undefined ? ` DEFAULT ${literal(f.default)}` : ''}${f.type === 'enum' ? ` CHECK (${q} IN (${f.values!.map(literal).join(', ')}))` : ''}${f.type === 'bool' ? ` CHECK (${q} IN (0,1))` : ''}${f.min !== undefined ? ` CHECK (${q} >= ${literal(f.min)})` : ''}`
}
export function createEntity(name: string, entity: InstanceConfig['entities'][string]) {
  const columns = [
    'id TEXT PRIMARY KEY', 'organization_id TEXT NOT NULL REFERENCES organizations(id)',
    'created_at TEXT NOT NULL', 'updated_at TEXT NOT NULL', 'version INTEGER NOT NULL DEFAULT 1',
    ...Object.entries(entity.fields).filter(([, f]) => !f.computed).map(([k, f]) => column(k, f)), 'UNIQUE (organization_id, id)',
    ...Object.entries(entity.fields).filter(([, f]) => f.type === 'ref' && !f.computed).map(([k, f]) => `FOREIGN KEY (organization_id, ${quote(k)}) REFERENCES ${quote(f.entity!)}(organization_id, id)`),
    ...entity.checks.map(c => `CHECK (${quote(c.left)} ${c.op} ${quote(c.right)})`),
  ]
  return `CREATE TABLE ${quote(name)} (\n  ${columns.join(',\n  ')}\n);\nCREATE INDEX ${quote(`${name}_org_idx`)} ON ${quote(name)}(organization_id, id);\n` + Object.entries(entity.fields).filter(([, f]) => f.type === 'ref' && !f.computed).map(([k]) => `CREATE INDEX ${quote(`${name}_${k}_idx`)} ON ${quote(name)}(organization_id, ${quote(k)});`).join('\n')
}

export const revisionSQL = (revision: number) => `INSERT INTO instance_meta VALUES (${revision}, '${CORE_VERSION}', strftime('%Y-%m-%dT%H:%M:%fZ','now'));`
// Revisions are the primary key: preserve older rows and refresh only the current
// revision's SDK stamp after deploy-time migration verification succeeds.
export const coreVersionSQL = (revision: number) => `UPDATE instance_meta SET core_version = ${literal(CORE_VERSION)}, applied_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE revision = ${literal(revision)} AND revision = (SELECT MAX(revision) FROM instance_meta) AND core_version <> ${literal(CORE_VERSION)};`
/** New-era Instance SQL owns domain tables and the domain revision only.
 * Preserve the inline defineInstance baseline until its consumers are retired. */
export function initialSchema(config: InstanceConfig) {
  const legacy = config.languages === undefined
    ? configuredSystemSchema(config) + opsSchema + (config.account?.entity === 'users' ? betterAuthSchema.replace('user_id TEXT NOT NULL REFERENCES users(id)', 'user_id TEXT NOT NULL REFERENCES "user"(id)') : betterAuthSchema) + emailDeliverySchema + workflowSchema
    : ''
  return legacy + Object.entries(config.entities).filter(([n]) => !(n === 'users' && config.account?.entity === n)).map(([n, e]) => createEntity(n, e)).join('\n') + '\n' + revisionSQL(config.revision) + '\n'
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
