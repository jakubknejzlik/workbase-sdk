import { defineInstance, inspectInstance, type InstanceConfig } from '../config'
import { column, createEntity, initialSchema, literal, quote, revisionSQL } from './schema'
import { rebuildWithNullableRefs, type SupplementalIndex } from './rebuild'
export interface MigrationPlan { sql: string; destructive: string[]; blocked: string[]; warnings: string[] }
export function plan(fromConfig: InstanceConfig | null, toConfig: InstanceConfig, options: { allowDestructive?: boolean; indexes?: SupplementalIndex[] } = {}): MigrationPlan {
  const to = defineInstance(toConfig)
  if (!fromConfig) return { sql: initialSchema(to), destructive: [], blocked: [], warnings: [] }
  // An older schema may violate a new presentation invariant; the result must
  // still pass strict validation above. Never alter its physical baseline.
  const from = inspectInstance(fromConfig).config
  if (from.id !== to.id) throw new Error('Cannot migrate between different instance IDs')
  if (to.revision <= from.revision) throw new Error('Target revision must increase')
  const sql: string[] = []; const destructive: string[] = []; const blocked: string[] = []; const warnings: string[] = []
  const rebuilds = new Map<string, string[]>()
  const referenceBackfills: string[] = []
  // Visit removed parents first, then reverse: every child is dropped before its refs.
  const removed = new Set(Object.keys(from.entities).filter(name => !to.entities[name]))
  const visited = new Set<string>(); const visiting = new Set<string>(); const parentsFirst: string[] = []
  function visit(name: string) {
    if (visited.has(name)) return
    if (visiting.has(name)) { blocked.push(`Cyclic table removals require a manually reviewed foreign_keys migration: ${name}`); return }
    visiting.add(name)
    for (const field of Object.values(from.entities[name].fields)) if (field.type === 'ref' && removed.has(field.entity!)) visit(field.entity!)
    visiting.delete(name); visited.add(name); parentsFirst.push(name)
  }
  for (const name of removed) visit(name)
  if (options.allowDestructive) for (const name of parentsFirst.reverse()) sql.push(`DROP TABLE ${quote(name)};`)
  for (const [name, previous] of Object.entries(from.entities)) {
    if (!to.entities[name]) {
      destructive.push(`DROP TABLE ${name}`)
      if (Object.values(to.entities).some(e => Object.values(e.fields).some(f => f.entity === name))) blocked.push(`Referenced table cannot be removed: ${name}`)
      continue
    }
    const next = to.entities[name]
    const renamed = new Set<string>()
    for (const [key, field] of Object.entries(next.fields)) {
      if (field.computed) {
        if (previous.fields[key] && !previous.fields[key].computed) blocked.push(`Converting stored field to computed requires a new field name: ${name}.${key}`)
        continue
      }
      if (previous.fields[key]?.computed) { blocked.push(`Converting computed field to stored requires a new field name: ${name}.${key}`); continue }
      if (field.renameFrom && field.renameFrom !== key && previous.fields[key] && previous.fields[field.renameFrom]) { blocked.push(`Rename target already exists: ${name}.${key}`); continue }
      const oldKey = field.renameFrom && !previous.fields[key] ? field.renameFrom : key
      const old = previous.fields[oldKey]
      if (oldKey !== key) {
        if (!old || next.fields[oldKey] || renamed.has(oldKey)) { blocked.push(`Ambiguous rename: ${name}.${oldKey} -> ${key}`); continue }
        renamed.add(oldKey)
        sql.push(`ALTER TABLE ${quote(name)} RENAME COLUMN ${quote(oldKey)} TO ${quote(key)};`)
        if (old.type === 'ref') {
          sql.push(`DROP INDEX ${quote(`${name}_${oldKey}_idx`)};`)
          sql.push(`CREATE INDEX ${quote(`${name}_${key}_idx`)} ON ${quote(name)}(organization_id, ${quote(key)});`)
        }
      }
      if (old) {
        const physical = (f: typeof field) => ({ type: f.type, required: f.required, values: f.values, entity: f.entity, default: f.default, min: f.min })
        if (JSON.stringify(physical(old)) !== JSON.stringify(physical(field))) {
          destructive.push(`ALTER definition ${name}.${key}`)
          blocked.push(`Changing an existing column's type/default/constraints requires a manually reviewed migration: ${name}.${key}`)
        }
      } else {
        if (field.type === 'ref') {
          if (field.required) blocked.push(`Required added reference needs a manually reviewed backfill migration: ${name}.${key}`)
          else if (name === 'users' && (from.account?.entity === name || to.account?.entity === name)) blocked.push(`Account entity users requires a manually reviewed credential-schema migration before adding reference: ${name}.${key}`)
          else {
            const added = rebuilds.get(name) ?? []; added.push(key); rebuilds.set(name, added)
            if (field.backfillFrom) {
              const ref = next.fields[field.backfillFrom.refField]
              // A replay must also preserve links deliberately cleared after the upgrade.
              referenceBackfills.push(`UPDATE ${quote(name)} SET ${quote(key)} = (SELECT source.${quote(field.backfillFrom.valueField)} FROM ${quote(ref.entity!)} source WHERE source.organization_id = ${quote(name)}.organization_id AND source.id = ${quote(name)}.${quote(field.backfillFrom.refField)}) WHERE NOT EXISTS (SELECT 1 FROM instance_meta WHERE revision = ${to.revision});`)
            }
          }
          continue
        }
        if (field.required && (field.default === undefined || field.default === null)) { blocked.push(`Required added field needs a non-null backfill default: ${name}.${key}`); continue }
        sql.push(`ALTER TABLE ${quote(name)} ADD COLUMN ${column(key, field)};`)
        if (field.backfillFrom) {
          const ref = next.fields[field.backfillFrom.refField]
          const source = `(SELECT source.${quote(field.backfillFrom.valueField)} FROM ${quote(ref.entity!)} source WHERE source.organization_id = ${quote(name)}.organization_id AND source.id = ${quote(name)}.${quote(field.backfillFrom.refField)})`
          const value = field.required && field.default !== undefined ? `COALESCE(${source}, ${literal(field.default)})` : source
          sql.push(`UPDATE ${quote(name)} SET ${quote(key)} = ${value};`)
        }
      }
    }
    for (const [key, field] of Object.entries(previous.fields)) {
      if (field.computed || next.fields[key] || renamed.has(key)) continue
      destructive.push(`DROP COLUMN ${name}.${key}`)
      if (field.type === 'ref' || previous.checks.some(c => c.left === key || c.right === key)) blocked.push(`Constraint-bearing column removal requires a manually reviewed migration: ${name}.${key}`)
      else if (options.allowDestructive) sql.push(`ALTER TABLE ${quote(name)} DROP COLUMN ${quote(key)};`)
    }
    const normalizedChecks = previous.checks.map(c => ({ ...c, left: Object.entries(next.fields).find(([, f]) => f.renameFrom === c.left)?.[0] ?? c.left, right: Object.entries(next.fields).find(([, f]) => f.renameFrom === c.right)?.[0] ?? c.right }))
    if (JSON.stringify(normalizedChecks) !== JSON.stringify(next.checks)) blocked.push(`Changing table checks requires a manually reviewed migration: ${name}`)
  }
  for (const [name, entity] of Object.entries(to.entities)) if (!from.entities[name]) sql.push(createEntity(name, entity))
  if (destructive.length && !options.allowDestructive) blocked.push('Destructive operations require --allow-destructive')
  if (destructive.length) warnings.push('Review destructive operations and take a backup before applying; this planner never applies SQL.')
  if (blocked.length) return { sql: `-- BLOCKED: ${blocked.join('\n-- ')}\n`, destructive, blocked, warnings }
  const rebuildSQL = [...rebuilds].map(([name, added]) => rebuildWithNullableRefs(name, from, to, added, options.indexes ?? []))
  // Validate the previous physical schema before any proposed ALTER statements.
  if (rebuildSQL.length) {
    sql.unshift('PRAGMA defer_foreign_keys = ON;', ...rebuildSQL.map(rebuild => rebuild.guard))
    for (const [i, rebuild] of rebuildSQL.entries()) {
      sql.push(rebuild.sql)
      // Keep the entire graph deferred until every table has its final shape.
      if (i === rebuildSQL.length - 1) sql.push(rebuild.check)
      sql.push(rebuild.cleanup)
    }
    sql.push('PRAGMA defer_foreign_keys = OFF;')
  }
  sql.push(...referenceBackfills)
  sql.push(rebuilds.size ? revisionSQL(to.revision).replace('INSERT INTO', 'INSERT OR IGNORE INTO') : revisionSQL(to.revision))
  return { sql: `-- ${from.id}: revision ${from.revision} -> ${to.revision}\n${sql.join('\n')}\n`, destructive, blocked, warnings }
}
