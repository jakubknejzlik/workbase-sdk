import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { serializeAccessLock } from '@workbasehq/core/access/lock'
import { accessSystemActions } from '@workbasehq/core/schema'
import { configSources, decodeSource, loadConfig, SourceError } from '@workbasehq/core/schema/load'
import { generate } from '@workbasehq/core/openapi/generate'
import { KernelRegistry } from '@workbasehq/core/kernel/registry'
import { expectedPluginMigrations, type PluginMigrationRow } from '@workbasehq/core/kernel/migrations'
import { checkSchema, parseLock } from '@workbasehq/core/migrations/schema-lock'
import type { Bundle } from '../storage.ts'
import { noLink } from '../storage.ts'
import { fail, type AccessChange, type PresentationChange, type RolesChange } from '../schemas.ts'
import { replaySources } from '../replay-sources.ts'
import { replaceLiteral } from './literal-edit.ts'
import { replayBundle, replayEngine, snapshot } from '../offline.ts'
import { replayInstance } from '../migration-replay.ts'
import { compare, stateRoot } from '../disposable.ts'

export const pluginLedger = (db: DatabaseSync) => db.prepare('SELECT namespace,name,position,checksum FROM _plugin_migrations ORDER BY namespace,position').all().map(row => ({ namespace: String(row.namespace), name: String(row.name), position: Number(row.position), checksum: String(row.checksum) }))

/** Interpret the original graph, edit literal spans, then compile the staged graph.
 * Consumer modules are never evaluated to obtain authored access declarations. */
export async function accessPlan(root: string, changes: (AccessChange | RolesChange)[]) {
  const original = await loadConfig(join(root, 'config.ts'))
  const { shared, entities } = original.authoredAccess
  if (!shared) fail('invalid_access', 'V3 access authoring requires access.ts')
  const inputs = await replaySources(root, { accessLock: true })
  const files = new Map<string, string>()
  const edit = (file: string, path: string[], value: unknown) => {
    files.set(file, replaceLiteral(files.get(file) ?? decodeSource(inputs[file], join(root, file)), path, value, join(root, file)))
  }
  const roleChanges = changes.filter(change => change.kind === 'set_roles')
  if (roleChanges.length > 1) fail('invalid_input', 'Provide only one set_roles operation per proposal')
  const roleChange = roleChanges[0]
  const removedRows: { file: string; path: string[]; before: unknown; after: null }[] = []
  if (roleChange) {
    const roles = roleChange.roles
    const removed = original.config.roles.filter(role => !roles.includes(role))
    const matrix = <T>(file: string, path: string[], previous: Record<string, T>, deny: () => T) => {
      for (const role of removed) if (Object.hasOwn(previous, role)) removedRows.push({ file, path: [...path, role], before: previous[role], after: null })
      return Object.fromEntries(roles.map(role => [role, Object.hasOwn(previous, role) ? previous[role] : deny()]))
    }
    // Stage the entire role graph before applying grants or compiling. Retain
    // grants only for identical identifiers; every new role starts denied.
    let configSource = decodeSource(await readFile(join(root, 'config.ts')), join(root, 'config.ts'))
    configSource = replaceLiteral(configSource, ['roles'], roles, join(root, 'config.ts'), { config: true })
    configSource = replaceLiteral(configSource, ['organizationOwnerRole'], roleChange.organizationOwnerRole, join(root, 'config.ts'), { config: true })
    files.set('config.ts', configSource)
    shared.roles = matrix('access.ts', ['roles'], shared.roles, () => ({ system: Object.fromEntries(accessSystemActions.map(action => [action, 'deny' as const])) }))
    edit('access.ts', ['roles'], shared.roles)
    for (const [entity, previous] of Object.entries(shared.entities)) {
      shared.entities[entity] = matrix('access.ts', ['entities', entity], previous, () => 'deny' as const)
      edit('access.ts', ['entities', entity], shared.entities[entity])
    }
    for (const [entity, previous] of Object.entries(entities)) {
      entities[entity] = matrix(`schema/${entity}.ts`, ['access'], previous!, () => 'deny' as const)
      edit(`schema/${entity}.ts`, ['access'], entities[entity])
    }
    for (const item of original.config.ui?.navigation?.items ?? []) for (const role of item.roles ?? []) {
      if (!roles.includes(role)) fail('role_reference_unresolved', `config.ts ui.navigation.items.${item.id}.roles references removed role ${role}; explicitly update the navigation declaration before proposing set_roles`, 422)
    }
  }
  for (const change of changes) {
    if (change.kind === 'set_roles') continue
    if (change.kind === 'set_system_access') {
      const known = Object.hasOwn(shared.roles, change.role)
      shared.roles[change.role] = { system: change.grants }
      edit('access.ts', known ? ['roles', change.role, 'system'] : ['roles'], known ? change.grants : shared.roles)
    } else if (change.kind === 'set_entity_access') {
      // The compiled config also includes SDK-owned entities such as users.
      const domain = Object.hasOwn(entities, change.entity)
      const matrix = { ...(domain ? entities[change.entity] : shared.entities[change.entity]), [change.role]: change.access }
      if (domain) { entities[change.entity] = matrix; edit(`schema/${change.entity}.ts`, ['access'], matrix) }
      else {
        const known = Object.hasOwn(shared.entities, change.entity)
        shared.entities[change.entity] = matrix
        edit('access.ts', known ? ['entities', change.entity] : ['entities'], known ? matrix : shared.entities)
      }
    } else {
      const present = shared.accountLinks !== undefined
      ;(shared.accountLinks ??= {})[change.entity] = { invitationRole: change.invitationRole }
      edit('access.ts', present ? ['accountLinks'] : [], present ? shared.accountLinks : shared)
    }
  }
  if (roleChange) for (const [entity, mapping] of Object.entries(shared.accountLinks ?? {})) {
    if (!roleChange.roles.includes(mapping.invitationRole) || mapping.invitationRole === roleChange.organizationOwnerRole) {
      fail('role_reference_unresolved', `access.ts accountLinks.${entity}.invitationRole (${mapping.invitationRole}) must reference a final non-owner role; include an explicit set_account_link operation`, 422)
    }
  }
  const target = await loadEditedConfig(root, inputs, files)
  if (roleChange) {
    try { checkSchema(target.config, parseLock(inputs['schema.lock.json'].toString('utf8'))) }
    catch { fail('schema_lock_mismatch', 'set_roles preserves the physical schema; run check:schema and repair the committed schema lock and migration history before proposing role changes', 422) }
  }
  return { ...target, ...(roleChange ? { roleDiff: {
    roles: { before: original.config.roles, after: roleChange.roles },
    organizationOwnerRole: { before: original.config.organizationOwnerRole, after: roleChange.organizationOwnerRole },
    removedRows,
  } } : {}) }
}

/** Names and languages are presentation metadata: preserve V3 source imports and lock binding. */
export async function presentationPlan(root: string, changes: PresentationChange[]) {
  if (!changes.length) return undefined
  const { config } = await loadConfig(join(root, 'config.ts'))
  let source = decodeSource(await readFile(join(root, 'config.ts')), join(root, 'config.ts'))
  for (const change of changes) {
    if (change.kind === 'set_instance_display_name') {
      source = replaceLiteral(source, ['displayName'], change.displayName, join(root, 'config.ts'), { config: true })
      continue
    }
    if (change.languages !== undefined) source = replaceLiteral(source, ['languages'], change.languages, join(root, 'config.ts'), { config: true })
    if (change.locale !== undefined) source = replaceLiteral(source, ['locale'], change.locale, join(root, 'config.ts'), { config: true })
    if (change.defaultLanguage !== undefined) {
      config.ui = { ...config.ui, entities: config.ui?.entities ?? {}, defaultLanguage: change.defaultLanguage }
      source = replaceLiteral(source, ['ui'], config.ui, join(root, 'config.ts'), { config: true })
    }
  }
  return loadEditedConfig(root, await replaySources(root, { accessLock: true }), new Map([['config.ts', source]]))
}

async function loadEditedConfig(root: string, inputs: Record<string, Buffer>, files: Map<string, string>) {
  await mkdir(stateRoot, { recursive: true }); await noLink(stateRoot)
  const scratch = await realpath(await mkdtemp(join(stateRoot, 'access-')))
  try {
    await writeFile(join(scratch, 'config.ts'), files.get('config.ts') ?? await readFile(join(root, 'config.ts')))
    for (const [path, bytes] of Object.entries(inputs)) {
      await mkdir(dirname(join(scratch, path)), { recursive: true })
      await writeFile(join(scratch, path), files.get(path) ?? bytes)
    }
    const loadOptions = { sdkResolutionRoot: root }
    const loaded = await loadConfig(join(scratch, 'config.ts'), loadOptions)
    // Presence in the captured instance graph is the artifact opt-in. Never
    // introduce OpenAPI into an instance that does not already maintain it.
    if (inputs['openapi.json']) {
      // Use the same generator as the CLI without its human stdout messages:
      // configuration MCP stdout must contain JSON-RPC frames only.
      const kernel = new KernelRegistry(loaded.config)
      files.set('openapi.json', generate(kernel.config, kernel, loaded.configHash))
    }
    return { config: loaded.config, files: [...files].map(([path, data]) => ({ path, data })) }
  } catch (error) {
    if (error instanceof SourceError) throw new SourceError({ ...error.location, file: join(root, relative(scratch, error.location.file)) }, error.message.replace(/^.*?:\d+:\d+: /, ''))
    throw error
  } finally { await rm(scratch, { recursive: true, force: true }) }
}

/** Record the upgrade that deploy will execute, and independently replay fresh. */
export async function compositionPlan(base: Bundle, target: Bundle, source: string, root: string, files = [{ path: 'runtime.ts', data: source }]) {
  root = await realpath(root)
  const engine = replayEngine(target.config, target.runtime)
  const ledger = await expectedPluginMigrations(engine.kernel.plugins, engine.kernel.config)
  const expected = await replayBundle(target, db => ({ schema: snapshot(db, true), ledger: pluginLedger(db) }))
  const statements: { sql: string; name: string }[] = []
  const db = new DatabaseSync(':memory:')
  let applied: PluginMigrationRow[]
  let upgradeStart: number
  try {
    const record = (sql: string, context?: { migration: string }) => statements.push({ sql, name: (context?.migration ?? 'ledger').replace(/[^a-z0-9_]/gi, '_') })
    // Interactive routing has no migration effect. A proposal may repair an
    // interactive instance that currently has no login provider.
    await replayInstance(db, base.migrations, replayEngine(base.config, { ...base.runtime!, interactive: false }), { record })
    applied = pluginLedger(db)
    const before = snapshot(db, true)
    upgradeStart = statements.length
    await replayInstance(db, target.migrations, engine, { record })
    const after = snapshot(db, true)
    const domain = (rows: typeof before) => rows.filter(row => Object.hasOwn(base.config.entities, String(row.table)))
    if (compare(domain(before), domain(after)).length) fail('composition_touches_domain_table', 'Composition migrations must preserve domain tables', 422)
    if (compare(expected.schema, after).length || JSON.stringify(pluginLedger(db)) !== JSON.stringify(expected.ledger)
      || JSON.stringify(expected.ledger) !== JSON.stringify(ledger)) fail('composition_migration_divergence', 'Upgrade and fresh composition migrations differ', 422)
  } finally { db.close() }

  // Source metadata must describe the exact authored graph being promoted.
  // Stage the captured graph and overlay edits without evaluating consumer code.
  await mkdir(stateRoot, { recursive: true }); await noLink(stateRoot)
  const scratch = await realpath(await mkdtemp(join(stateRoot, 'composition-')))
  let lock: ReturnType<typeof serializeAccessLock>
  try {
    const inputs = { ...await replaySources(root), 'config.ts': await readFile(join(root, 'config.ts')), 'runtime.ts': Buffer.from(source) }
    const edits = new Map(files.map(file => [file.path, file.data]))
    for (const [path, bytes] of Object.entries(inputs)) {
      await mkdir(dirname(join(scratch, path)), { recursive: true })
      await writeFile(join(scratch, path), edits.get(path) ?? bytes)
    }
    const sources = Object.fromEntries(Object.entries(configSources(join(scratch, 'config.ts'), { sdkResolutionRoot: root }))
      .map(([key, location]) => [key, { ...location, file: join(root, relative(scratch, location.file)) }]))
    lock = serializeAccessLock(engine.kernel, { root, sources })
  } finally { await rm(scratch, { recursive: true, force: true }) }
  return {
    files: [...files, { path: 'access.lock.json', data: lock.json }, { path: 'access.lock.md', data: lock.md }],
    expected: expected.schema, statements, ledger,
    pluginMigrations: ledger.map(row => ({ ...row, status: applied.some(previous => previous.namespace === row.namespace && previous.name === row.name) ? 'applied' : 'new' })),
    pluginSql: statements.slice(upgradeStart).map(statement => statement.sql).join('\n'),
  }
}
