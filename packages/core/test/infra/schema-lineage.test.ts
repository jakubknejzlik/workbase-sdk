import { cpSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { checkSchema, lockBytes, parseLock, schemaLock } from '../../src/migrations/schema-lock'
import { checkLinkage, plan } from '../../src/migrations/schema-plan'
import { createPhysicalNameResolver } from '../../src/schema/physical-names'
import { bindSchemaLock, defineConfig, defineEntity } from '../../src/schema'
import { loadConfig } from '../../src/schema/load'
import { runSchemaCli } from '../../src/migrations/schema-cli'
import { plan as legacyPlan } from '../../src/migrations/planner'
import fixture from '../fixtures/config-era/config'

const v1 = readFileSync('packages/core/test/fixtures/config-era/schema.lock.json', 'utf8')
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
function consumer() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lineage-'))); roots.push(root)
  cpSync(resolve('packages/core/test/fixtures/config-era'), root, { recursive: true })
  return root
}
const renamed = () => {
  const config = structuredClone(fixture)
  config.entities.worker.fields.full_name = { ...config.entities.worker.fields.name, renameFrom: 'name' }
  delete config.entities.worker.fields.name
  return config
}

it('bootstraps v1 deterministically without changing physical specs, revision or migration bytes', async () => {
  const before = readFileSync('packages/core/test/fixtures/config-era/migrations/0001_r1.sql', 'utf8')
  const lock = parseLock(v1)
  expect(lock.lockVersion).toBe(2)
  expect(lockBytes(parseLock(v1))).toBe(lockBytes(lock))
  expect(lock.tables).toEqual(JSON.parse(v1).tables)
  expect(lock.revision).toBe(JSON.parse(v1).revision)
  expect(lock.transitions).toEqual([])
  expect(lock.entities[0]).toMatchObject({ id: 'ent_776f726b6572', logicalName: 'worker', physicalName: 'worker' })
  expect(lock.entities[0].fields.find(f => f.logicalName === 'name')?.id).toBe('fld_776f726b6572_6e616d65')
  expect(lock.entities[0].fields.every(f => f.id.startsWith('fld_') && f.logicalName === f.physicalName)).toBe(true)
  const files = { '0001_r1.sql': before }
  const result = await plan({ config: fixture, baseLock: v1, baseMigrations: files })
  expect(result.bundle).toBeUndefined()
  expect(parseLock(result.lock)).toEqual(lock)
  await checkLinkage(v1, files, result.lock, files)
  expect(readFileSync('packages/core/test/fixtures/config-era/migrations/0001_r1.sql', 'utf8')).toBe(before)
})

it('records an explicit field intent with stable IDs and keeps the expanded mapping on the source', async () => {
  const base = parseLock(v1), config = renamed(), lock = schemaLock(config, base)
  expect(lock.entities).toEqual(base.entities)
  expect(lock.tables).toEqual(base.tables)
  const entity = base.entities[0], field = entity.fields.find(f => f.logicalName === 'name')!
  expect(lock.transitions).toEqual([{ id: expect.any(String), entityId: entity.id, fieldIds: [field.id], from: { logical: 'name', physical: 'name' }, to: { logical: 'full_name', physical: 'full_name' }, bridge: 'field', phase: 'expanded' }])
  expect(schemaLock(config, lock).transitions).toEqual(lock.transitions)
  expect(() => checkSchema(config, lock)).not.toThrow()
  await expect(plan({ config, baseLock: v1, baseMigrations: {} })).rejects.toThrow(`transition ${lock.transitions[0].id}`)
  await expect(checkLinkage(v1, {}, lockBytes(lock), {})).rejects.toThrow(`transition ${lock.transitions[0].id}`)
})

it('accepts entity renameFrom syntax and records identity without emitting a table rename', async () => {
  expect(defineEntity({ renameFrom: 'worker', fields: { name: { type: 'text' } } }).renameFrom).toBe('worker')
  const base = parseLock(v1), config = structuredClone(fixture)
  config.entities.staff = { ...config.entities.worker, renameFrom: 'worker' }
  delete config.entities.worker
  const lock = schemaLock(config, base)
  expect(lock.entities).toEqual(base.entities)
  expect(lock.transitions[0]).toMatchObject({ entityId: base.entities[0].id, bridge: 'entity', phase: 'expanded', from: { logical: 'worker', physical: 'worker' }, to: { logical: 'staff', physical: 'staff' } })
  await expect(plan({ config, baseLock: v1, baseMigrations: {} })).rejects.toThrow('expansion SQL is unsupported')
})

it.each(['missing source', 'source retained', 'duplicate source', 'target collision', 'definition', 'second open', 'implicit source', 'unrelated edit'])('rejects %s', kind => {
  const base = parseLock(v1), config = renamed()
  if (kind === 'missing source') config.entities.worker.fields.full_name.renameFrom = 'absent'
  if (kind === 'source retained') config.entities.worker.fields.name = fixture.entities.worker.fields.name
  if (kind === 'duplicate source') config.entities.worker.fields.other = { ...config.entities.worker.fields.full_name }
  if (kind === 'target collision') { config.entities.worker.fields.user = config.entities.worker.fields.full_name; delete config.entities.worker.fields.full_name }
  if (kind === 'definition') config.entities.worker.fields.full_name.required = false
  if (kind === 'second open') base.transitions = schemaLock(config, base).transitions
  if (kind === 'second open') { config.entities.worker.fields.label = { ...config.entities.worker.fields.user, renameFrom: 'user' }; delete config.entities.worker.fields.user }
  if (kind === 'implicit source') config.entities.worker.fields.full_name.renameFrom = 'id'
  if (kind === 'unrelated edit') config.entities.worker.fields.extra = { type: 'text', required: false }
  expect(() => schemaLock(config, base)).toThrow()
})

it('never infers a rename from matching definitions', () => {
  const config = renamed(); delete config.entities.worker.fields.full_name.renameFrom
  expect(() => schemaLock(config, parseLock(v1))).toThrow('dropping or renaming')
})

it.each(['entity id', 'field id', 'physical collision', 'unknown transition', 'two open', 'invalid phase'])('validates v2 %s', kind => {
  const lock = schemaLock(renamed(), parseLock(v1))
  if (kind === 'entity id') lock.entities.push({ ...lock.entities[0], logicalName: 'other', physicalName: 'other' })
  if (kind === 'field id') lock.entities[0].fields[1].id = lock.entities[0].fields[0].id
  if (kind === 'physical collision') lock.entities[0].fields[1].physicalName = lock.entities[0].fields[0].physicalName
  if (kind === 'unknown transition') lock.transitions[0].entityId = 'ent_missing'
  if (kind === 'two open') lock.transitions.push({ ...lock.transitions[0], id: 'tr_other' })
  if (kind === 'invalid phase') Object.assign(lock.transitions[0], { phase: 'unknown' })
  expect(() => parseLock(lockBytes(lock))).toThrow('schema.lock.json')
})

it('retains contracted history while allowing a later intent; refuses history edits and reused IDs', async () => {
  const base = schemaLock(renamed(), parseLock(v1))
  // A future slice produced this completed transition and mapping.
  base.transitions[0].phase = 'contracted'
  base.entities[0].fields.find(f => f.logicalName === 'name')!.logicalName = 'full_name'
  base.entities[0].fields.find(f => f.physicalName === 'name')!.physicalName = 'full_name'
  base.tables[0].columns.find(c => c.name === 'name')!.name = 'full_name'
  const config = renamed(); delete config.entities.worker.fields.full_name.renameFrom
  config.entities.worker.fields.label = { ...config.entities.worker.fields.full_name, renameFrom: 'full_name' }; delete config.entities.worker.fields.full_name
  const next = schemaLock(config, base)
  expect(next.transitions[0]).toEqual(base.transitions[0])
  expect(next.transitions).toHaveLength(2)
  const editedHistory = structuredClone(base); editedHistory.transitions[0].id = 'tr_edited'
  await expect(checkLinkage(lockBytes(base), {}, lockBytes(editedHistory), {})).rejects.toThrow('history is immutable')
  const initial = schemaLock(fixture), tampered = structuredClone(initial)
  tampered.entities[0].fields[0].id = 'fld_reassigned'
  await expect(checkLinkage(lockBytes(initial), {}, lockBytes(tampered), {})).rejects.toThrow('immutable')
})

it.each(['field', 'entity'] as const)('assigns deterministic unique IDs after a completed %s rename cycle', kind => {
  const initial = parseLock(v1)
  const entityId = initial.entities[0].id
  const fieldId = initial.entities[0].fields.find(f => f.logicalName === 'name')!.id
  let config = structuredClone(fixture), base = initial
  const names = kind === 'field' ? ['name', 'full_name', 'name', 'full_name'] : ['worker', 'staff', 'worker', 'staff']
  for (let i = 0; i < 3; i++) {
    const from = names[i], to = names[i + 1]
    if (kind === 'field') {
      config.entities.worker.fields[to] = { ...config.entities.worker.fields[from], renameFrom: from }
      delete config.entities.worker.fields[from]
    } else {
      config.entities[to] = { ...config.entities[from], renameFrom: from }
      delete config.entities[from]
    }
    const next = schemaLock(config, base)
    expect(next).toEqual(schemaLock(config, base))
    expect(next.transitions.slice(0, i)).toEqual(base.transitions)
    expect(new Set(next.transitions.map(t => t.id)).size).toBe(i + 1)
    expect(schemaLock(config, next)).toEqual(next)
    const prefix = kind === 'field'
      ? 'tr_776f726b6572_776f726b6572_6e616d65_6e616d65_66756c6c5f6e616d65'
      : 'tr_776f726b6572_entity_776f726b6572_7374616666'
    if (i === 2) {
      expect(next.transitions[0].id).toBe(`${prefix}_1`)
      expect(next.transitions[2].id).toBe(`${prefix}_3`)
      break
    }
    // Model a future slice's completed mapping; no phase advancement SQL here.
    next.transitions[i].phase = 'contracted'
    const entity = next.entities.find(e => e.id === entityId)!
    const table = next.tables.find(t => t.name === entity.physicalName)!
    if (kind === 'field') {
      const field = entity.fields.find(f => f.id === fieldId)!
      table.columns.find(c => c.name === field.physicalName)!.name = to
      field.logicalName = to; field.physicalName = to
      delete config.entities.worker.fields[to].renameFrom
    } else {
      entity.logicalName = to; entity.physicalName = to; table.name = to
      table.indexes = table.indexes.map(index => ({ ...index, name: to + index.name.slice(from.length) }))
      delete config.entities[to].renameFrom
    }
    base = parseLock(lockBytes(next))
    expect(() => checkSchema(config, base)).not.toThrow()
  }
})

it.each(['field', 'entity'] as const)('accepts a canonical %s rename from constructor', kind => {
  const canonical = (entities: Parameters<typeof defineConfig>[0]['entities']) => defineConfig({
    id: 'canonical', languages: ['en'], roles: ['admin'], organizationOwnerRole: 'admin', entities,
  })
  const original = kind === 'field'
    ? canonical({ worker: defineEntity({ fields: { name: { type: 'text' }, constructor: { type: 'text' } } }) })
    : canonical({ constructor: defineEntity({ fields: { name: { type: 'text' } } }) })
  const config = kind === 'field'
    ? canonical({ worker: defineEntity({ fields: { name: { type: 'text' }, title: { type: 'text', renameFrom: 'constructor' } } }) })
    : canonical({ staff: defineEntity({ renameFrom: 'constructor', fields: { name: { type: 'text' } } }) })
  const base = schemaLock(original)
  expect(() => checkSchema(original, base)).not.toThrow()
  const lock = schemaLock(config, base)
  expect(lock.entities).toEqual(base.entities)
  expect(lock.tables).toEqual(base.tables)
  expect(lock.transitions[0]).toMatchObject({ bridge: kind, from: { logical: 'constructor', physical: 'constructor' }, to: { logical: kind === 'field' ? 'title' : 'staff' } })
  expect(() => checkSchema(config, lock)).not.toThrow()
})

it('resolves validated logical identities to pinned physical names and rejects cross-entity IDs', () => {
  const lock = schemaLock(renamed(), parseLock(v1)), resolver = createPhysicalNameResolver(lock)
  const entityId = resolver.entityId('worker'), fieldId = resolver.fieldId(entityId, 'name')
  expect(resolver.table(entityId)).toBe('worker')
  expect(resolver.column(entityId, fieldId)).toBe('name')
  expect(() => resolver.entityId('staff')).toThrow()
  expect(() => resolver.fieldId(entityId, 'full_name')).toThrow()
  expect(() => resolver.column('ent_other', fieldId)).toThrow()
  lock.entities[0].physicalName = 'mutated'
  expect(resolver.table(entityId)).toBe('worker')
})

it('runtime binding validates v2, including duplicate IDs, and accepts deterministic v1 bootstrap', () => {
  const config = structuredClone(fixture), lock = parseLock(v1)
  expect(bindSchemaLock(config, lock).revision).toBe(lock.revision)
  expect(bindSchemaLock(config, JSON.parse(v1)).revision).toBe(lock.revision)
  lock.entities[0].fields[1].id = lock.entities[0].fields[0].id
  expect(() => bindSchemaLock(config, lock)).toThrow('schema.lock.json')
})

it('SDK-era calls through the older planner also block rename SQL by transition ID', () => {
  const config = renamed(); config.revision = fixture.revision + 1
  const lock = schemaLock(config, parseLock(v1))
  const result = legacyPlan(fixture, config)
  expect(result.blocked.join(' ')).toContain(`transition ${lock.transitions[0].id}`)
  expect(result.sql).not.toMatch(/ALTER TABLE|CREATE TABLE|DROP/)
})

it('the loader preserves entity renameFrom and its source location with a v2 lock', async () => {
  const root = consumer()
  renameSync(join(root, 'schema/worker.ts'), join(root, 'schema/staff.ts'))
  const file = join(root, 'schema/staff.ts')
  writeFileSync(file, readFileSync(file, 'utf8').replace('defineEntity({', "defineEntity({\n  renameFrom: 'worker',"))
  const configFile = join(root, 'config.ts')
  writeFileSync(configFile, readFileSync(configFile, 'utf8').replaceAll('worker', 'staff'))
  writeFileSync(join(root, 'schema.lock.json'), lockBytes(parseLock(v1)))
  const loaded = await loadConfig(configFile)
  expect(loaded.config.entities.staff.renameFrom).toBe('worker')
  expect(loaded.sources['entities.staff.renameFrom']).toMatchObject({ file, line: 3 })
  const lock = schemaLock(loaded.config, parseLock(v1), loaded.sources)
  expect(lock.transitions[0].bridge).toBe('entity')
  loaded.config.entities.staff.renameFrom = 'missing'
  expect(() => schemaLock(loaded.config, parseLock(v1), loaded.sources)).toThrow(`${file}:2: staff:`)
})

it('rename planning through the CLI fails before writing either lock or migration files', async () => {
  const root = consumer(), file = join(root, 'schema/worker.ts')
  const lock = readFileSync(join(root, 'schema.lock.json'), 'utf8')
  const files = readdirSync(join(root, 'migrations'))
  const migration = readFileSync(join(root, 'migrations/0001_r1.sql'), 'utf8')
  const { execFileSync } = await import('node:child_process')
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Synthetic'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'synthetic@example.test'], { cwd: root })
  execFileSync('git', ['add', '.'], { cwd: root }); execFileSync('git', ['commit', '-qm', 'base'], { cwd: root })
  writeFileSync(file, readFileSync(file, 'utf8').replace("name: { type: 'text'", "full_name: { renameFrom: 'name', type: 'text'"))
  await expect(runSchemaCli('plan', ['--root', root, '--base', 'HEAD'])).rejects.toThrow(/transition .*expansion SQL is unsupported/)
  expect(readFileSync(join(root, 'schema.lock.json'), 'utf8')).toBe(lock)
  expect(readdirSync(join(root, 'migrations'))).toEqual(files)
  expect(readFileSync(join(root, 'migrations/0001_r1.sql'), 'utf8')).toBe(migration)
})

it.each(['missing', 'retained', 'duplicate', 'collision', 'definition', 'field and entity'])('rejects entity rename %s', kind => {
  const base = parseLock(v1), config = structuredClone(fixture)
  config.entities.staff = { ...config.entities.worker, renameFrom: 'worker' }
  delete config.entities.worker
  if (kind === 'missing') config.entities.staff.renameFrom = 'missing'
  if (kind === 'retained') config.entities.worker = fixture.entities.worker
  if (kind === 'duplicate') config.entities.other = { ...config.entities.staff }
  if (kind === 'collision') { config.entities.users = config.entities.staff; delete config.entities.staff }
  if (kind === 'definition') config.entities.staff.fields.name.required = false
  if (kind === 'field and entity') { config.entities.staff.fields.full_name = { ...config.entities.staff.fields.name, renameFrom: 'name' }; delete config.entities.staff.fields.name }
  expect(() => schemaLock(config, base)).toThrow()
})

it('names the open transition when a second field intent is rejected', () => {
  const base = schemaLock(renamed(), parseLock(v1)), config = structuredClone(fixture)
  config.entities.worker.fields.account = { ...config.entities.worker.fields.user, renameFrom: 'user' }
  delete config.entities.worker.fields.user
  expect(() => schemaLock(config, base)).toThrow(`second open transition for ${base.entities[0].id}; finish transition ${base.transitions[0].id} first`)
})

it('a metadata-only bootstrap cannot change parent, revision, IDs or migrations', async () => {
  const base = parseLock(v1)
  for (const change of [{ parent: 'a'.repeat(64) }, { revision: base.revision + 1 }]) {
    await expect(checkLinkage(v1, {}, lockBytes({ ...base, ...change }), {})).rejects.toThrow()
  }
  const changed = structuredClone(base); changed.entities[0].id = 'ent_changed'
  await expect(checkLinkage(v1, {}, lockBytes(changed), {})).rejects.toThrow('immutable')
  const files = { '0001_r1.sql': readFileSync('packages/core/test/fixtures/config-era/migrations/0001_r1.sql', 'utf8') }
  await expect(checkLinkage(v1, files, lockBytes(base), { '0001_r1.sql': files['0001_r1.sql'] + '\n' })).rejects.toThrow('base migration edited')
})

it('new storage IDs are deterministic across declaration order and preserve existing identities', () => {
  const base = parseLock(v1), config = structuredClone(fixture)
  config.entities.worker.fields.z = { type: 'text', required: false }
  config.entities.worker.fields.a = { type: 'int', required: false }
  config.entities.other = structuredClone(config.entities.worker)
  const first = schemaLock(config, base)
  config.entities = Object.fromEntries(Object.entries(config.entities).reverse())
  config.entities.worker.fields = Object.fromEntries(Object.entries(config.entities.worker.fields).reverse())
  expect(schemaLock(config, base)).toEqual(first)
  for (const field of base.entities[0].fields) expect(first.entities.find(e => e.id === base.entities[0].id)!.fields).toContainEqual(field)
})
