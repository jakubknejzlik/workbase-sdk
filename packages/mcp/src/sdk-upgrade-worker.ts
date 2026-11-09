// Candidate bridge, copied with its protocol into a standalone installed consumer.
// It never imports the target MCP's planning/offline/disposable implementation.
import { DatabaseSync } from 'node:sqlite'
import { registerHooks } from 'node:module'
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertBound, bridgeDigest, consumerModules, digestBytes, inside, requestSchema, type UpgradeRequest } from './sdk-upgrade-protocol.ts'

const q = (name: string) => `"${name.replaceAll('"', '""')}"`
const normalize = (sql: string) => sql.trim().replace(/;$/, '').replace(/('(?:''|[^'])*')|"(?:""|[^"])*"|\s+/g, match => /^\s/.test(match) ? ' ' : match)
// Compare full DDL (constraints/triggers included), columns, FKs and indexes.
function physical(db: DatabaseSync) {
  return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','index','trigger') AND sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name NOT IN ('_migrations','_plugin_migrations','d1_migrations') AND tbl_name NOT IN ('_migrations','_plugin_migrations','d1_migrations') ORDER BY type,name").all().map(row => ({
    type: row.type, name: row.name, table: row.tbl_name, sql: normalize(String(row.sql)),
    ...(row.type === 'table' ? {
      columns: db.prepare(`PRAGMA table_info(${q(String(row.name))})`).all(),
      foreignKeys: db.prepare(`PRAGMA foreign_key_list(${q(String(row.name))})`).all(),
    } : row.type === 'index' ? { columns: db.prepare(`PRAGMA index_info(${q(String(row.name))})`).all() } : {}),
  }))
}
async function sqliteFiles(directory: string): Promise<string[]> {
  const paths: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name), stat = await lstat(path)
    if (stat.isSymbolicLink()) throw new Error('Linked disposable database')
    if (stat.isDirectory()) paths.push(...await sqliteFiles(path))
    else if (/^[a-f0-9]{64}\.sqlite$/.test(entry.name)) paths.push(path)
  }
  return paths
}
async function checkInputs(root: string, request: UpgradeRequest) {
  for (const [path, hash] of Object.entries(request.inputHashes)) {
    if (!(await lstat(join(root, path))).isFile() || digestBytes(await readFile(join(root, path))) !== hash) throw new Error(`Changed bridge input: ${path}`)
  }
  if (await bridgeDigest(join(root, '.sdk-bridge')) !== request.identity.bridgeDigest) throw new Error('Bridge source digest mismatch')
}

export async function runBridge(root: string, raw: unknown) {
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context)
    if (context.parentURL?.startsWith('file:') && inside(root, fileURLToPath(context.parentURL))
      && resolved.url.startsWith('file:') && !inside(root, fileURLToPath(resolved.url))) throw new Error(`Module resolution outside consumer: ${specifier}`)
    return resolved
  } })
  try { return await executeBridge(root, raw) } finally { hooks.deregister() }
}
async function executeBridge(root: string, raw: unknown) {
  const request = requestSchema.parse(raw)
  await checkInputs(root, request)
  const { packages, resolutions } = await consumerModules(root)
  for (const pkg of packages) if (pkg.version !== request.identity.targetVersion) throw new Error('Uncoordinated target SDK')
  const load = async (specifier: string) => {
    if (!resolutions[specifier]) throw new Error(`Unresolved consumer export: ${specifier}`)
    return import(pathToFileURL(resolutions[specifier]).href)
  }
  const { CORE_VERSION, defineInstance } = await load('@workbasehq/core/config') as typeof import('@workbasehq/core/config')
  const { initialSchema, coreVersionSQL, quote } = await load('@workbasehq/core/migrations/schema') as typeof import('@workbasehq/core/migrations/schema')
  const { KernelRegistry } = await load('@workbasehq/core/kernel/registry') as typeof import('@workbasehq/core/kernel/registry')
  const { migrateD1, migrateInstance, queryDatabase, readMigrationFiles } = await load('@workbasehq/core/infra') as typeof import('@workbasehq/core/infra')
  const { pluginMigrationStatus } = await load('@workbasehq/core/kernel/migrations') as typeof import('@workbasehq/core/kernel/migrations')
  if (CORE_VERSION !== request.identity.targetVersion) throw new Error('Target CORE_VERSION mismatch')
  const config = defineInstance((await import(pathToFileURL(join(root, 'config.ts')).href)).default)
  if (config.id !== request.identity.instanceId || config.revision !== request.identity.baseRevision) throw new Error('Captured configuration identity mismatch')
  const kernel = new KernelRegistry(config)
  // Validate archived sources with the target SDK as well. JSON history hydrates
  // only canonical published exports, never serialized executable hooks.
  const descriptors: Record<string, [specifier: string, exported: string]> = {
    identity: ['@workbasehq/plugins/identity', 'createIdentity'],
    permissions: ['@workbasehq/plugins/permissions', 'permissions'],
    rbac: ['@workbasehq/plugins/permissions', 'legacyPermissions'],
    tenancy: ['@workbasehq/core/plugins', 'tenancy'],
    members: ['@workbasehq/plugins/members', 'createMembers'],
    organizations: ['@workbasehq/plugins/organizations', 'createOrganizations'],
    'local-auth': ['@workbasehq/plugins/local-auth', 'createLocalAuth'],
    'machine-credentials': ['@workbasehq/plugins/machine-credentials', 'machineCredentials'],
    'mail-outbox': ['@workbasehq/plugins/mail-outbox', 'mailOutbox'],
    audit: ['@workbasehq/plugins/audit', 'audit'], console: ['@workbasehq/plugins/console', 'consoleUI'],
  }
  for (const path of Object.keys(request.inputHashes)) if (/^config\.v[1-9][0-9]*\.ts$/.test(path)) defineInstance((await import(pathToFileURL(join(root, path)).href)).default)
  if (request.inputHashes['config.versions.json']) {
    const history = JSON.parse(await readFile(join(root, 'config.versions.json'), 'utf8'))
    if (!Array.isArray(history)) throw new Error('Invalid configuration history')
    for (const saved of history) {
      if (!Number.isSafeInteger(saved.revision) || saved.revision < 1 || saved.revision > config.revision) throw new Error('Invalid historical revision')
      const plugins = await Promise.all((saved.config.plugins ?? []).map(async (plugin: { name: string; configuration?: unknown }) => {
        if (!Object.hasOwn(descriptors, plugin.name)) throw new Error(`Unsupported historical plugin: ${plugin.name}`)
        const [specifier, exported] = descriptors[plugin.name]
        const canonical = (await load(specifier))[exported]
        return typeof canonical === 'function' ? canonical(plugin.configuration) : canonical
      }))
      new KernelRegistry(defineInstance({ ...saved.config, revision: saved.revision, plugins }))
    }
  }
  const names = Object.keys(request.inputHashes).filter(path => path.startsWith('migrations/')).sort()
  if (!names.length || names.some((path, i) => Number(path.slice(11, 15)) !== i + 1) || names.length >= 9999) throw new Error('Invalid migration sequence or filename limit')
  const markerPath = `migrations/${String(names.length + 1).padStart(4, '0')}_sdk_upgrade.sql`
  const markerSQL = coreVersionSQL(config.revision) + '\n'
  const marker = { path: markerPath, sha256: digestBytes(markerSQL) }
  if (request.action === 'prepare') {
    await writeFile(join(root, markerPath), markerSQL, { flag: 'wx' })
    const files = await readMigrationFiles(join(root, 'migrations'))
    const statements: string[] = []
    // Ask the target migration engine for its exact replay SQL and receipts.
    await migrateD1(async sql => { if (!sql.startsWith('SELECT ')) statements.push(sql); return [{ success: true, results: [] }] }, files)
    const replay = statements.join('\n') + '\n'
    const preflight = new DatabaseSync(':memory:')
    try {
      preflight.exec(replay)
      const meta = preflight.prepare('SELECT revision,core_version FROM instance_meta ORDER BY revision DESC LIMIT 1').get()
      if (meta?.revision !== config.revision || meta.core_version !== CORE_VERSION) throw new Error('Wrong staged target marker')
    } finally { preflight.close() }
    await writeFile(join(root, '.sdk-bridge/replay.sql'), replay, { flag: 'wx' })
    await checkInputs(root, request)
    return { kind: 'prepared', identity: request.identity, inputHashes: request.inputHashes, stage: { marker, replaySha256: digestBytes(replay) } }
  }
  assertBound(marker, request.stage!.marker, 'target-generated marker')
  if (digestBytes(await readFile(join(root, markerPath))) !== marker.sha256 || digestBytes(await readFile(join(root, '.sdk-bridge/replay.sql'))) !== request.stage!.replaySha256) throw new Error('Changed staged SQL')
  const files = await readMigrationFiles(join(root, 'migrations'))
  const databases = await sqliteFiles(join(root, '.sdk-bridge/persist/v3/d1'))
  if (databases.length !== 1) throw new Error('Expected exactly one target Wrangler disposable D1')
  const db = new DatabaseSync(databases[0]), desired = new DatabaseSync(':memory:')
  const queryFor = (database: DatabaseSync) => async (sql: string) => {
    database.exec('BEGIN')
    try {
      const results = /^\s*(?:SELECT|PRAGMA)\b/i.test(sql) ? database.prepare(sql).all() : (database.exec(sql), [])
      database.exec('COMMIT')
      return [{ success: true, results }]
    } catch (error) { database.exec('ROLLBACK'); throw error }
  }
  const metaSQL = 'SELECT revision,core_version FROM instance_meta ORDER BY revision DESC LIMIT 1'
  try {
    // Check BEFORE migrateInstance: its normal SDK stamping must not repair a bad
    // staged marker and turn an invalid replay into an accepted upgrade result.
    const meta = db.prepare(metaSQL).get()
    if (meta?.revision !== config.revision || meta.core_version !== CORE_VERSION) throw new Error('Wrong replayed target marker')
    await migrateInstance(queryFor(db), files, kernel)
    const indexes = request.inputHashes['config.indexes.json'] ? JSON.parse(await readFile(join(root, 'config.indexes.json'), 'utf8')) : []
    if (!Array.isArray(indexes)) throw new Error('Invalid index list')
    const indexSQL = indexes.map((index: { name: string; entity: string; fields: string[] }) => {
      if (!kernel.config.entities[index.entity] || !Array.isArray(index.fields) || !index.fields.length || index.fields.some(field => !kernel.config.entities[index.entity].fields[field])) throw new Error('Invalid configured index')
      return `CREATE INDEX ${quote(index.name)} ON ${quote(index.entity)} (${['organization_id', ...index.fields].map(quote).join(', ')});`
    }).join('\n')
    desired.exec(initialSchema(kernel.config) + indexSQL)
    await kernel.applyMigrations(queryDatabase(queryFor(desired)))
    const plugins = await pluginMigrationStatus(queryDatabase(queryFor(db)), kernel.plugins, kernel.config)
    const desiredPlugins = await pluginMigrationStatus(queryDatabase(queryFor(desired)), kernel.plugins, kernel.config)
    if (plugins.expected !== plugins.applied || plugins.expected !== desiredPlugins.applied) throw new Error('Target plugin migrations differ')
    const schema = { status: 'pass', expected: digestBytes(JSON.stringify(physical(desired))), applied: digestBytes(JSON.stringify(physical(db))) }
    if (schema.expected !== schema.applied) throw new Error('Target physical schema requires additional repair')
    const final = db.prepare(metaSQL).get()
    if (final?.revision !== config.revision || final.core_version !== CORE_VERSION) throw new Error('Wrong final target marker')
    await checkInputs(root, request)
    return { kind: 'verified', identity: request.identity, inputHashes: request.inputHashes, stage: request.stage,
      coreVersion: CORE_VERSION, packages, resolutions, schema, plugins, marker: { version: CORE_VERSION, revision: config.revision } }
  } finally { db.close(); desired.close() }
}

// File arguments and output stay in the private consumer; stdout is never proof.
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const root = resolve(import.meta.dirname, '..')
  const result = await runBridge(root, JSON.parse(await readFile(join(root, '.sdk-bridge/request.json'), 'utf8')))
  await writeFile(join(root, '.sdk-bridge/result.json'), JSON.stringify(result) + '\n', { flag: 'wx' })
}
