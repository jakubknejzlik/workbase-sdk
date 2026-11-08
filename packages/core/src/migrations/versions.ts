import { cloneInstanceConfig, inspectInstance, serializableInstanceConfig, type InstanceConfig } from '../config'
import { plan, type MigrationPlan } from './planner'

import type { ConfigVersion, ConfigChange, VersionHistory } from './version-contract'
export type { ConfigVersion, ConfigChange, VersionHistory } from './version-contract'

export const versionData = (config: InstanceConfig): Record<string, unknown> => {
  const { plugins: _plugins, revision: _revision, ...data } = serializableInstanceConfig(config)
  return JSON.parse(JSON.stringify({ ...data, ...(config.plugins ? { plugins: config.plugins.map(({ name, version, provides, requires, optionalRequires, configuration }) => ({ name, version, provides, requires, optionalRequires, configuration })) } : {}) }))
}
const stable = (value: unknown): string => JSON.stringify(value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(item => JSON.parse(stable(item))) : Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, JSON.parse(stable(v))])) : value ?? null)
export const equalVersionData = (a: Record<string, unknown>, b: Record<string, unknown>) => stable(a) === stable(b)
export const sameVersionData = (a: InstanceConfig, b: InstanceConfig) => stable(versionData(a)) === stable(versionData(b))

/** Stable structured values, rather than a text diff of source formatting. */
export function diffVersions(before: Record<string, any> | null, after: Record<string, any>): ConfigChange[] {
  const changes: ConfigChange[] = []
  const compare = (kind: ConfigChange['kind'], prefix: string, a: Record<string, unknown> = {}, b: Record<string, unknown> = {}) => {
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (stable(a[key]) === stable(b[key]) && Object.hasOwn(a, key) === Object.hasOwn(b, key)) continue
      changes.push({ kind, path: `${prefix}${key}`, change: !Object.hasOwn(a, key) ? 'added' : !Object.hasOwn(b, key) ? 'removed' : 'changed',
        ...(Object.hasOwn(a, key) ? { before: a[key] } : {}), ...(Object.hasOwn(b, key) ? { after: b[key] } : {}) })
    }
  }
  const a = before ?? {}; compare('entity', 'entities.', a.entities, after.entities)
  for (const entity of Object.keys(after.entities ?? {})) {
    if (a.entities?.[entity]) {
      const { fields: oldFields, ...oldMeta } = a.entities[entity]
      const { fields: newFields, ...newMeta } = after.entities[entity]
      const index = changes.findIndex(c => c.path === `entities.${entity}`)
      if (index !== -1 && stable(oldMeta) === stable(newMeta)) changes.splice(index, 1)
      else if (index !== -1) changes[index] = { kind: 'entity', path: `entities.${entity}`, change: 'changed', before: oldMeta, after: newMeta }
      compare('field', `entities.${entity}.fields.`, oldFields, newFields)
    } else compare('field', `entities.${entity}.fields.`, {}, after.entities[entity].fields)
  }
  for (const entity of Object.keys(a.entities ?? {})) if (!after.entities?.[entity]) compare('field', `entities.${entity}.fields.`, a.entities[entity].fields, {})
  for (const entity of [...new Set([...Object.keys(a.ui?.entities ?? {}), ...Object.keys(after.ui?.entities ?? {})])].sort()) {
    const views = (data: any) => Object.fromEntries((data?.ui?.entities?.[entity]?.views ?? []).map((v: any) => [v.id ?? v.kind, v]))
    const presets = (data: any) => Object.fromEntries((data?.ui?.entities?.[entity]?.list?.views ?? []).map((v: any) => [v.id ?? v.kind, v]))
    compare('view', `ui.entities.${entity}.views.`, views(a), views(after))
    compare('view', `ui.entities.${entity}.list.views.`, presets(a), presets(after))
  }
  const { entities: _a, ui: _au, ...restA } = a; const { entities: _b, ui: _bu, ...restB } = after
  compare('config', '', restA, restB)
  const remainingUi = (data: any) => {
    if (!data.ui) return {}
    const { entities, ...restUi } = data.ui
    const hints = Object.fromEntries(Object.entries(entities ?? {}).flatMap(([key, value]: [string, any]) => {
      const { views: _views, list, ...rest } = value
      const { views: _presets, ...remainingList } = list ?? {}
      const remaining = { ...rest, ...(Object.keys(remainingList).length ? { list: remainingList } : {}) }
      return Object.keys(remaining).length ? [[key, remaining]] : []
    }))
    return { ...restUi, ...(Object.keys(hints).length ? { entities: hints } : {}) }
  }
  compare('config', 'ui.', remainingUi(a), remainingUi(after))
  return changes
}

export const unchangedRollbackPlan = (revision: number): MigrationPlan => ({ sql: `-- Configuration already matches v${revision}; no version or migration will be created.\n`, blocked: [], destructive: [], warnings: [] })

export function planRollback(current: InstanceConfig, historical: InstanceConfig, options: { allowDestructive?: boolean } = {}): { target: InstanceConfig; plan: MigrationPlan; unchanged: boolean } {
  if (current.id !== historical.id) throw new Error('Cannot roll back between different instance IDs')
  if (historical.revision > current.revision) throw new Error('Rollback target must be an existing revision')
  const target = cloneInstanceConfig(historical)
  target.revision = current.revision + 1
  const unchanged = sameVersionData(current, historical)
  const migration = plan(current, target, options)
  if (migration.destructive.length) migration.warnings.unshift('Rollback may delete populated tables or columns. No live data was inspected; all drops require explicit --allow-destructive and prior contract review.')
  return { target, plan: migration, unchanged }
}

export function versionHistory(current: InstanceConfig, history: readonly ConfigVersion[]): VersionHistory {
  const versions = [...history].sort((a, b) => a.revision - b.revision)
  if (new Set(versions.map(v => v.revision)).size !== versions.length) throw new Error('Duplicate config version')
  if (versions.some(v => !Number.isSafeInteger(v.revision) || v.revision < 1 || v.config.id !== current.id || v.revision > current.revision)) throw new Error('Invalid config history')
  const live: ConfigVersion = { revision: current.revision, config: versionData(current) }
  const index = versions.findIndex(v => v.revision === current.revision)
  if (index === -1) versions.push(live)
  else versions[index] = { ...versions[index], config: live.config }
  return { instance: current.id, currentRevision: current.revision, versions: versions.map((version, i) => {
    const inspected = inspectInstance({ ...version.config, revision: version.revision, plugins: undefined, pluginConfig: undefined, interactive: false } as unknown as InstanceConfig)
    if (inspected.errors.length) return {
      revision: version.revision, date: version.date, commit: version.commit, rollbackTo: version.rollbackTo,
      predecessor: versions[i - 1]?.revision, changes: diffVersions(versions[i - 1]?.config ?? null, version.config),
      rollback: { sql: '-- BLOCKED: historical config needs displayField repair before rollback.\n', blocked: inspected.errors.map(error => error.message), destructive: [], warnings: [], unchanged: false, newRevision: current.revision + 1 },
    }
    const historical = inspected.config
    const rollback = planRollback({ ...current, plugins: undefined, pluginConfig: undefined, interactive: false }, historical)
    const unchanged = equalVersionData(version.config, versionData(current))
    return { revision: version.revision, date: version.date, commit: version.commit, rollbackTo: version.rollbackTo,
      predecessor: versions[i - 1]?.revision, changes: diffVersions(versions[i - 1]?.config ?? null, version.config),
      rollback: { ...(unchanged ? unchangedRollbackPlan(current.revision) : rollback.plan), unchanged, newRevision: unchanged ? current.revision : rollback.target.revision } }
  }) }
}
