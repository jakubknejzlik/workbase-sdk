import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { reset } from 'cloudflare:test'
import { defineInstance } from '../src/config'
import { diffVersions, planRollback, versionData, versionHistory } from '../src/migrations/versions'

const base = defineInstance({ id: 'version_test', revision: 1, roles: ['owner'], entities: { items: { fields: { title: { type: 'string' }, notes: { type: 'text' } } } }, permissions: { owner: { items: ['read', 'create', 'update', 'delete'] } } })
const current = defineInstance({ ...base, revision: 2, entities: { items: { fields: { title: { type: 'string' } } } } })
beforeEach(reset)
it('rollback is a new forward version, expands safely and preserves populated rows', async () => {
  await env.DB.exec("CREATE TABLE items (id TEXT, title TEXT); INSERT INTO items VALUES ('one','Keep me'); CREATE TABLE instance_meta (revision INTEGER, core_version TEXT, applied_at TEXT);")
  const result = planRollback(current, base)
  expect(result.target.revision).toBe(3)
  expect(versionData(result.target)).toEqual(versionData(base))
  expect(result.plan.blocked).toEqual([])
  expect(result.plan.destructive).toEqual([])
  expect(result.plan.sql).toContain('ADD COLUMN "notes" TEXT')
  await env.DB.exec(result.plan.sql.split('\n').filter(line => !line.startsWith('--')).join(' '))
  expect(await env.DB.prepare('SELECT title, notes FROM items').first()).toEqual({ title: 'Keep me', notes: null })
  expect(await env.DB.prepare('SELECT max(revision) FROM instance_meta').first('max(revision)')).toBe(3)
})
it('refuses a populated column drop before returning executable SQL; an explicit override is required', async () => {
  await env.DB.exec("CREATE TABLE items (id TEXT, title TEXT, notes TEXT); INSERT INTO items VALUES ('one','Keep me','Valuable data');")
  const result = planRollback({ ...base, revision: 3 }, { ...current, revision: 2 })
  expect(result.plan.destructive).toEqual(['DROP COLUMN items.notes'])
  expect(result.plan.blocked).toContain('Destructive operations require --allow-destructive')
  expect(result.plan.sql).not.toMatch(/ALTER TABLE|INSERT INTO|DROP TABLE/)
  expect(result.plan.warnings.join(' ')).toContain('No live data was inspected')
  expect(await env.DB.prepare('SELECT notes FROM items').first('notes')).toBe('Valuable data')
  expect(planRollback({ ...base, revision: 3 }, current, { allowDestructive: true }).plan.sql).toContain('DROP COLUMN "notes"')
})
it('refuses a table removal and keeps manual-review constraints blocked even with the override', () => {
  const larger = defineInstance({ ...base, revision: 3, entities: { ...base.entities, extras: { fields: { value: { type: 'text' } } } } })
  expect(planRollback(larger, base).plan.destructive).toContain('DROP TABLE extras')
  expect(planRollback(larger, base).plan.blocked.length).toBeGreaterThan(0)
  const changed = defineInstance({ ...base, revision: 3, entities: { items: { fields: { title: { type: 'int' }, notes: { type: 'text' } } } } })
  expect(planRollback(changed, base, { allowDestructive: true }).plan.blocked.join(' ')).toContain('manually reviewed migration')
})
it('is deterministic, does not mutate history, and recognizes an identical retry', () => {
  const before = versionData(base)
  expect(planRollback(current, base)).toEqual(planRollback(current, base))
  expect(planRollback(planRollback(current, base).target, base).unchanged).toBe(true)
  expect(versionData(base)).toEqual(before)
  expect(base.revision).toBe(1)
  expect(current.revision).toBe(2)
  expect(() => planRollback(base, current)).toThrow('existing revision')
  expect(() => planRollback(current, { ...base, id: 'elsewhere' })).toThrow('instance IDs')
})
it('structured diffs distinguish entity, field and view additions/removals/changes and ignore object key order', () => {
  const before = { entities: { items: { fields: { title: { type: 'string' }, obsolete: { type: 'text' } } } }, ui: { entities: { items: { views: [{ kind: 'calendar', startField: 'created_at' }], list: { views: [{ id: 'old', label: 'Old' }] } } } } }
  const after = { entities: { items: { fields: { title: { type: 'text' }, notes: { type: 'text' } } }, added: { fields: {} } }, ui: { entities: { items: { views: [{ kind: 'calendar', startField: 'updated_at' }], list: { views: [{ id: 'new', label: 'New' }] } } } } }
  const changes = diffVersions(before, after)
  expect(changes).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'entity', path: 'entities.added', change: 'added' }),
    expect.objectContaining({ kind: 'field', path: 'entities.items.fields.obsolete', change: 'removed' }),
    expect.objectContaining({ kind: 'field', path: 'entities.items.fields.notes', change: 'added' }),
    expect.objectContaining({ kind: 'field', path: 'entities.items.fields.title', change: 'changed' }),
    expect.objectContaining({ kind: 'view', path: 'ui.entities.items.views.calendar', change: 'changed' }),
    expect.objectContaining({ kind: 'view', path: 'ui.entities.items.list.views.old', change: 'removed' }),
    expect.objectContaining({ kind: 'view', path: 'ui.entities.items.list.views.new', change: 'added' }),
  ]))
  expect(diffVersions({ roles: ['owner'], id: 'demo' }, { id: 'demo', roles: ['owner'] })).toEqual([])
})
it('history sorts numerically, compares with its predecessor and handles sparse/unarchived current revisions', () => {
  const history = versionHistory({ ...current, revision: 10 }, [{ revision: 2, config: versionData(current) }, { revision: 1, config: versionData(base) }])
  expect(history.versions.map(v => v.revision)).toEqual([1, 2, 10])
  expect(history.versions[1].predecessor).toBe(1)
  expect(history.versions[1].rollback.newRevision).toBe(10)
  expect(history.versions[1].rollback.sql).toContain('no version or migration will be created')
  expect(history.versions[2].commit).toBeUndefined()
  expect(() => versionHistory(current, [{ revision: 1, config: versionData(base) }, { revision: 1, config: versionData(base) }])).toThrow('Duplicate')
})
