import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { defineInstance, type InstanceConfig } from '@workbasehq/core/config'
import { equalVersionData, planRollback, unchangedRollbackPlan, versionData, type ConfigVersion } from '@workbasehq/core/migrations/versions'
import { configSource, json, noLink, type Bundle, type Store } from './storage'
import { fail } from './schemas'
import { hydratePlugins } from './template'
import type { WorkbasePlugin } from '@workbasehq/core'

type File = { path: string; data: string; create?: boolean }
export async function readVersions(directory: string): Promise<ConfigVersion[]> {
  const path = join(directory, 'config.versions.json')
  await noLink(path, true)
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
}
export async function loadVersion(directory: string, revision: number): Promise<InstanceConfig> {
  if (!Number.isSafeInteger(revision) || revision < 1) fail('invalid_version', 'Expected vN with a positive integer revision')
  const saved = (await readVersions(directory)).find(v => v.revision === revision)
  if (!saved) fail('version_not_found', `Archived v${revision} is unavailable`)
  return defineInstance({ ...saved.config, revision, plugins: await hydratePlugins(saved.config.plugins as WorkbasePlugin[] | undefined) } as unknown as InstanceConfig)
}

/** Archive resolved source and update the browser-safe history in the same file transaction. */
export async function versionFiles(directory: string, current: InstanceConfig, next: InstanceConfig, rollbackTo?: number): Promise<File[]> {
  const history = await readVersions(directory)
  const files: File[] = []
  for (const config of [current, next]) {
    const revision = config.revision
    const path = `config.v${revision}.ts`
    const existing = (await readdir(directory)).includes(path)
    if (existing && config === next) fail('version_conflict', `Version source v${revision} already exists; resolve it before planning`, 409)
    if (!existing) files.push({ path, data: configSource(config), create: true })
    const recorded = history.find(v => v.revision === revision)
    // Loading an older archive now materializes built-ins. Compare only this
    // automatic projection; retain the recorded bytes and every grant exactly.
    const recordedConfig = recorded ? structuredClone(recorded.config) : undefined
    if (recordedConfig && Array.isArray(recordedConfig.roles)) {
      for (const role of [config.organizationOwnerRole, 'member']) if (!recordedConfig.roles.includes(role)) {
        recordedConfig.roles.push(role)
        if (role === config.organizationOwnerRole) {
          const grants = recordedConfig.organizationPermissions as Record<string, unknown> | undefined
          recordedConfig.organizationPermissions = { ...grants, [role]: grants?.[role] ?? [] }
        }
      }
    }
    if (recordedConfig && !equalVersionData(recordedConfig, versionData(config))) fail('version_conflict', `Recorded v${revision} differs; increase the revision before planning`, 409)
    if (!recorded) history.push({ revision, date: new Date().toISOString(), ...(config === next && rollbackTo ? { rollbackTo } : {}), config: versionData(config) })
  }
  files.push({ path: 'config.versions.json', data: json(history.sort((a, b) => a.revision - b.revision)) })
  return files
}

/** Offline operation: writes reviewable local files only, and never opens a database. */
export async function rollback(store: Store, instance: string, to: number, options: { allowDestructive?: boolean; expectedRevision?: number; preview?: boolean } = {}) {
  return store.locked(instance, async () => {
    const bundle: Bundle = await store.load(instance)
    if (options.expectedRevision !== undefined && options.expectedRevision !== bundle.config.revision) fail('stale_revision', 'Revision changed; inspect history again', 409)
    const directory = await store.directory(instance)
    if (to > bundle.config.revision) fail('invalid_version', 'Rollback target must be an existing revision')
    const historical = to === bundle.config.revision ? bundle.config : await loadVersion(directory, to)
    const result = planRollback(bundle.config, historical, options)
    if (result.unchanged) result.plan = unchangedRollbackPlan(bundle.config.revision)
    for (const index of bundle.indexes) if (!result.target.entities[index.entity] || index.fields.some(field => !result.target.entities[index.entity].fields[field])) {
      result.plan.blocked.push(`Index ${index.name} references removed fields; a manually reviewed index migration is required`)
    }
    if (result.plan.blocked.length) result.plan.sql = `-- BLOCKED: ${result.plan.blocked.join('\n-- ')}\n`
    const preview = { ok: result.plan.blocked.length === 0, fromRevision: bundle.config.revision, to, newRevision: result.unchanged ? bundle.config.revision : result.target.revision, unchanged: result.unchanged, ...result.plan, appliesToDatabase: false }
    if (result.plan.blocked.length || options.preview) return { ...preview, written: false as const }
    // An identical retry must not create another revision/migration.
    if (result.unchanged) return { ...preview, newRevision: bundle.config.revision, unchanged: true, written: false as const }
    const migration = await publishConfigVersion(store, instance, bundle, result.target, result.plan.sql, `rollback_to_v${to}`, to)
    return { ...preview, migration, written: true as const }
  })
}

/** Shared CLI/MCP/local-console publication: caller holds Store.locked; no DB or deploy. */
export async function publishConfigVersion(store: Store, instance: string, bundle: Bundle, target: InstanceConfig, sql: string, slug: string, rollbackTo?: number) {
  const number = Math.max(0, ...bundle.migrations.map(m => Number(m.name.slice(0, 4)))) + 1
  if (number > 9999) fail('migration_limit', 'Migration number exceeds four digits')
  const migration = `${String(number).padStart(4, '0')}_${slug}.sql`
  await store.commit(instance, [
    ...await versionFiles(await store.directory(instance), bundle.config, target, rollbackTo),
    { path: `migrations/${migration}`, data: sql, create: true },
    { path: 'config.ts', data: configSource(target, { history: true }) },
  ], bundle.guards)
  return migration
}
