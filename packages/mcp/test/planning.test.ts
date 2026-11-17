import { cloneInstanceConfig } from '@workbasehq/core/config'
import { defineInstance } from '@workbasehq/core/config'
import { describe, expect, it } from 'vitest'
import { sample, secondary, migrations } from './fixtures/model'
import { prepare } from '../src/planning.ts'
import { expectedSnapshot, instanceMeta, replay, snapshot } from '../src/offline.ts'
import { schemas, WorkflowError, type Change } from '../src/schemas.ts'
import { applyDisposable, compare } from '../src/disposable.ts'
import { createEntity, initialSchema } from '@workbasehq/core/migrations/schema'
const bundle = { config: sample, indexes: [], fingerprint: '', guards: {}, migrations: migrations(sample) }

it.each([
  ['generated column', 'columns', (sql: string) => sql.replace('"name" TEXT', '"name" TEXT, derived TEXT GENERATED ALWAYS AS (upper(name)) VIRTUAL')],
  ['WITHOUT ROWID', 'rowid', (sql: string) => sql.replace(');\nCREATE INDEX', ') WITHOUT ROWID;\nCREATE INDEX')],
  ['partial UNIQUE known index', 'indexes', (sql: string) => sql.replace('CREATE INDEX "people_org_idx" ON "people"(organization_id, id)', 'CREATE UNIQUE INDEX "people_org_idx" ON "people"(organization_id, name) WHERE name IS NOT NULL')],
  ['inline UNIQUE', 'indexes', (sql: string) => sql.replace('"name" TEXT', '"name" TEXT UNIQUE')],
] as const)('rejects physical drift with closed diagnostics in replay and real disposable D1: %s', async (_label, difference, modify) => {
  const config = defineInstance({ id: 'physical_guard', revision: 1, roles: ['owner'], entities: { people: { fields: { name: { type: 'string' } } } } })
  const original = createEntity('people', config.entities.people)
  const physical = { config, indexes: [], fingerprint: '', guards: {}, migrations: [{ name: '0001_initial.sql', sql:
    initialSchema(config).replace(original, modify(original)) + "\nINSERT INTO organizations VALUES ('org','Org'); INSERT INTO people (id,organization_id,name,created_at,updated_at) VALUES ('p','org','Person','now','now');" }] }
  const prepared = prepare(config, [], [{ kind: 'add_relation', entity: 'people', name: 'manager', field: 'manager_id', target: 'people' }])
  const message = `Rebuild blocked for people: physical ${difference.replaceAll('_', ' ')} differs from the fresh configured schema; a manually reviewed migration is required`
  await expect(expectedSnapshot(physical, prepared)).rejects.toThrow(expect.objectContaining({ code: 'migration_blocked', status: 400, message }))
  // Bypass offline replay to exercise Wrangler's own named-CHECK error transport.
  expect(await applyDisposable(physical, prepared, [], false)).toMatchObject({ verified: false, diffs: [{ code: 'migration_blocked', message }] })
})

it('surfaces users account credential-schema refusal during MCP planning', () => {
  const config = defineInstance({ id: 'account_guard', revision: 1, roles: ['owner'], account: { entity: 'users' }, entities: { users: { fields: { name: { type: 'string' } } } } })
  expect(() => prepare(config, [], [{ kind: 'add_relation', entity: 'users', name: 'manager', field: 'manager_id', target: 'users' }])).toThrow(expect.objectContaining({ code: 'migration_blocked', message: expect.stringMatching(/Account entity users.*credential/) }))
})

describe('safe planning', () => {
  it('defaults a new entity displayField to its first required string and honors explicit choices', () => {
    const fields = { email: { type: 'string' as const }, name: { type: 'string' as const, required: true }, title: { type: 'string' as const, required: true } }
    expect(prepare(sample, [], [{ kind: 'add_entity', entity: 'record', fields, permissions: { owner: ['read'] } }]).target.entities.record.displayField).toBe('name')
    expect(prepare(sample, [], [{ kind: 'add_entity', entity: 'record', fields, displayField: 'title' }]).target.entities.record.displayField).toBe('title')
  })
  it('reports core display-field validation through the MCP validation error contract', () => {
    const run = () => prepare(sample, [], [{ kind: 'add_entity', entity: 'record', fields: { name: { type: 'string', required: true } }, displayField: 'missing', permissions: { owner: ['read'] } }])
    expect(run).toThrow(expect.objectContaining({ code: 'invalid_input', status: 400, message: expect.stringContaining("Invalid displayField: record; set displayField: 'name' to an existing readable field") }))
    expect(() => prepare(sample, [], [{ kind: 'add_entity', entity: 'record', fields: { count: { type: 'int' } }, permissions: { owner: ['read'] } }])).toThrow('Invalid displayField: record')
  })
  it('uses the core planner and validates the resulting schema', async () => {
    const p = prepare(sample, [], [{ kind: 'add_field', entity: 'jobs', field: 'notes', definition: { type: 'text' } }])
    expect(p.sql.replaceAll('"', '')).toContain('ALTER TABLE jobs ADD COLUMN notes TEXT')
    expect(p.target.revision).toBe(sample.revision + 1)
    expect((await expectedSnapshot(bundle, p)).some(t => t.name === 'jobs')).toBe(true)
    expect((await instanceMeta(bundle)).revision).toBe(sample.revision)
  })
  it('carries displayField and UI hints through a rename in both instance configs', () => {
    for (const [config, entity] of [[sample, 'jobs'], [secondary, 'tasks']] as const) {
      const before = cloneInstanceConfig(config)
      const hinted = cloneInstanceConfig(config)
      hinted.ui = { entities: { [entity]: { list: {
        columns: ['title', 'id'], search: ['title'],
        sort: { title: { fields: ['title', 'created_at'] }, id: { fields: ['title', 'id'] } },
        defaultSort: { key: 'title', direction: 'desc' },
      } } } }
      const hintedBefore = cloneInstanceConfig(hinted)
      const p = prepare(hinted, [], [
        { kind: 'rename_field', entity, from: 'title', to: 'summary' },
      ])
      expect(p.target.entities[entity].displayField).toBe('summary')
      expect(p.target.entities[entity].fields.summary).toBeDefined()
      expect(p.target.entities[entity].fields.title).toBeUndefined()
      expect(p.patch).toContainEqual({ op: 'replace', path: `/config/entities/${entity}/displayField`, value: 'summary' })
      expect(p.target.ui?.entities[entity].list).toEqual({
        columns: ['summary', 'id'], search: ['summary'],
        sort: { summary: { fields: ['summary', 'created_at'] }, id: { fields: ['summary', 'id'] } },
        defaultSort: { key: 'summary', direction: 'desc' },
      })
      expect(hinted).toEqual(hintedBefore)
      expect(config).toEqual(before)
    }
  })
  it('refuses removal and incompatible edits of display fields with a typed error', () => {
    for (const [config, entity] of [[sample, 'jobs'], [secondary, 'tasks']] as const) {
      for (const change of [
        { kind: 'remove_field', entity, field: 'title' },
        { kind: 'alter_field', entity, field: 'title', definition: { type: 'int' } },
        { kind: 'add_field', entity, field: 'title', definition: { type: 'int' } },
      ]) {
        const before = cloneInstanceConfig(config)
        const run = () => prepare(config, [], [change as Change])
        expect(run).toThrow(WorkflowError)
        expect(run).toThrow(expect.objectContaining({ code: change.kind === 'add_field' ? 'field_exists' : 'invalid_input', status: 400 }))
        expect(config).toEqual(before)
      }
    }
  })
  it('supports new referenced entities, relation aliases, non-unique indexes and rename', async () => {
    const p = prepare(sample, [], [
      { kind: 'add_entity', entity: 'materials', fields: { label: { type: 'text' }, job_id: { type: 'ref', entity: 'jobs' } } },
      { kind: 'add_relation', entity: 'materials', name: 'job', field: 'job_id', target: 'jobs' },
      { kind: 'add_index', entity: 'materials', name: 'materials_label_idx', fields: ['label'] },
      { kind: 'rename_field', entity: 'jobs', from: 'title', to: 'summary' },
    ])
    expect(await expectedSnapshot(bundle, p)).toBeTruthy()
    expect(p.target.permissions.viewer.materials).toEqual([])
  })
  it('treats SQL-shaped defaults as data and verifies ordinary names resembling internal prefixes', async () => {
    const p = prepare(sample, [], [
      { kind: 'add_entity', entity: 'acfx', fields: { name: { type: 'text' } } },
      { kind: 'add_field', entity: 'jobs', field: 'notes', definition: { type: 'text', default: "x'); DROP TABLE jobs; --" } },
    ])
    const schema = await expectedSnapshot(bundle, p)
    expect(schema.some(t => t.name === 'jobs')).toBe(true)
    expect(schema.some(t => t.name === 'acfx')).toBe(true)
  })
  it('detects missing/changed indexes, extra tables and altered columns during verification', async () => {
    const p = prepare(sample, [], [{ kind: 'add_field', entity: 'jobs', field: 'notes', definition: { type: 'text' } }])
    const expected = await expectedSnapshot(bundle, p)
    const actual = replay([...bundle.migrations, { name: 'proposal.sql', sql: p.sql }], db => {
      db.exec('DROP INDEX jobs_org_idx; CREATE INDEX jobs_org_idx ON jobs(title); DROP INDEX jobs_client_id_idx; ALTER TABLE jobs RENAME COLUMN notes TO other_notes; CREATE TABLE unexpected (id TEXT);')
      return snapshot(db)
    })
    const diffs = compare(expected, actual) as { name: string }[]
    expect(diffs.map(d => d.name)).toEqual(expect.arrayContaining(['jobs', 'jobs_org_idx', 'jobs_client_id_idx', 'unexpected']))
  })
  it('rejects destructive operations, extra input and protected fields', () => {
    expect(schemas.propose_change.safeParse({ instance: 'sample', baseRevision: 2, changes: [{ kind: 'drop_field', entity: 'jobs', field: 'title' }] }).success).toBe(false)
    for (const [entity, field] of [['jobs', 'id'], ['slots', 'booked'], ['slots', 'capacity'], ['bookings', 'status'], ['jobs', 'status'], ['stock_items', 'quantity']]) {
      expect(() => prepare(sample, [], [{ kind: 'rename_field', entity, from: field, to: 'other' }])).toThrow()
    }
  })
})

it('C7b rename carries disabled filter hints and nested root view predicates', () => {
  const hinted = defineInstance({ ...sample, ui: { entities: { jobs: { list: { filter: { title: false }, views: [{ id: 'named', label: 'viewNamed', where: { and: [{ title: { contains: 'Case' } }, { not: { title: { eq: 'Other' } } }] } }] } } } } })
  const result = prepare(hinted, [], [{ kind: 'rename_field', entity: 'jobs', from: 'title', to: 'summary' }])
  expect(result.target.ui?.entities.jobs.list).toMatchObject({ filter: { summary: false }, views: [{ where: { and: [{ summary: { contains: 'Case' } }, { not: { summary: { eq: 'Other' } } }] } }] })
})
it('C7b rename follows view relation context without rewriting scalar operands', () => {
  const hinted = defineInstance({ ...secondary, ui: { entities: { tasks: { list: { views: [{ id: 'named', label: 'viewNamed', where: { and: [{ client: { name: { contains: 'name' } } }, { title: { contains: 'name' } }] } }] } } } } })
  const result = prepare(hinted, [], [{ kind: 'rename_field', entity: 'clients', from: 'name', to: 'label' }])
  expect(result.target.ui?.entities.tasks.list?.views?.[0].where).toEqual({ and: [{ client: { label: { contains: 'name' } } }, { title: { contains: 'name' } }] })
})

it('SR-79 field renames preserve separate form views and section membership', () => {
  const config = defineInstance({ id: 'forms', revision: 1, roles: ['owner'],
    entities: { clients: { fields: { name: { type: 'string', required: true }, email: { type: 'string' } } } },
    permissions: { owner: { clients: ['read', 'create', 'update'] } },
    ui: { entities: { clients: {
      form: { create: { fields: ['name', 'email'] }, edit: { fields: ['email'] } },
      sections: [{ id: 'contact', label: 'Contact', fields: ['name', 'email'] }],
    } } },
  })
  const result = prepare(config, [], [{ kind: 'rename_field', entity: 'clients', from: 'email', to: 'contact_email' }])
  expect(result.target.ui?.entities.clients).toMatchObject({
    form: { create: { fields: ['name', 'contact_email'] }, edit: { fields: ['contact_email'] } },
    sections: [{ id: 'contact', label: 'Contact', fields: ['name', 'contact_email'] }],
  })
  expect(config.ui?.entities.clients.form?.create?.fields).toEqual(['name', 'email'])
})

it('SR-80 field renames follow detail items, conditions, metrics and related columns', () => {
  const config = defineInstance({ id: 'details', revision: 1, roles: ['owner'],
    entities: { clients: { fields: { name: { type: 'string' }, email: { type: 'string' } } }, jobs: { displayField: 'id', fields: { client_id: { type: 'ref', entity: 'clients' } }, relations: { client: { entity: 'clients', field: 'client_id' } } } },
    permissions: { owner: { clients: ['read'], jobs: ['read'] } },
    ui: { entities: { clients: { detail: { summary: ['email'], groups: [{ id: 'main', label: 'Main', fields: [{ field: 'name', when: { field: 'email', eq: null } }] }], metrics: [{ field: 'email' }] } }, jobs: { detail: { relations: { client: { columns: ['email'], defaultSort: { key: 'email', direction: 'asc' } } } } } } },
  })
  const { target } = prepare(config, [], [{ kind: 'rename_field', entity: 'clients', from: 'email', to: 'contact_email' }])
  expect(target.ui?.entities.clients.detail).toMatchObject({ summary: ['contact_email'], groups: [{ fields: [{ field: 'name', when: { field: 'contact_email', eq: null } }] }], metrics: [{ field: 'contact_email' }] })
  expect(target.ui?.entities.jobs.detail?.relations?.client).toEqual({ columns: ['contact_email'], defaultSort: { key: 'contact_email', direction: 'asc' } })
})

it('SR-83 field renames preserve calendar start, end and title declarations', () => {
  const config = defineInstance({ id: 'calendar', revision: 1, roles: ['owner'],
    entities: { events: { fields: { name: { type: 'string' }, start: { type: 'datetime' }, end: { type: 'datetime' } } } },
    permissions: { owner: { events: ['read'] } },
    ui: { entities: { events: { views: [{ kind: 'calendar', startField: 'start', endField: 'end', titleField: 'name' }] } } },
  })
  const result = prepare(config, [], [
    { kind: 'rename_field', entity: 'events', from: 'start', to: 'scheduled_at' },
    { kind: 'rename_field', entity: 'events', from: 'end', to: 'ends_at' },
    { kind: 'rename_field', entity: 'events', from: 'name', to: 'title' },
  ])
  expect(result.target.ui?.entities.events.views).toEqual([{ kind: 'calendar', startField: 'scheduled_at', endField: 'ends_at', titleField: 'title' }])
  expect(config.ui?.entities.events.views?.[0].startField).toBe('start')
})

it('SR-83 field renames preserve composite calendar title operands and secondary fields', () => {
  const config = defineInstance({ id: 'calendar', revision: 1, roles: ['owner'],
    entities: { events: { fields: { name: { type: 'string' }, start: { type: 'datetime' } } } },
    permissions: { owner: { events: ['read'] } },
    ui: { entities: { events: { views: [{ kind: 'calendar', startField: 'start', titleFields: ['name'], secondaryField: 'name' }] } } },
  })
  expect(prepare(config, [], [{ kind: 'rename_field', entity: 'events', from: 'name', to: 'title' }]).target.ui?.entities.events.views).toEqual([{ kind: 'calendar', startField: 'start', titleFields: ['title'], secondaryField: 'title' }])
})

it('reference service parity: MCP validate and sdk check expose identical source-located diagnostics without editing sources', async () => {
  const { mkdtemp, realpath, readFile, writeFile, symlink, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join, resolve } = await import('node:path')
  const { bootstrapInstance } = await import('../src/bootstrap')
  const { runOpenApiCli } = await import('@workbasehq/core/openapi/cli')
  const { runSchemaCli } = await import('@workbasehq/core/migrations/schema-cli')
  const { createServer } = await import('../src/server')
  const { validateInstance } = await import('@workbasehq/plugins/console/ui/check')
  const { validateReferenceSources } = await import('../src/planning')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'wb140-parity-')))
  let server: Awaited<ReturnType<typeof createServer>> | undefined
  try {
    await bootstrapInstance(root, { id: 'reference_parity', target: 'cloudflare-github' })
    await symlink(resolve('node_modules'), join(root, 'node_modules'))
    expect(await runSchemaCli('plan', ['--root', root, '--init'])).toBe(0)
    expect(await runOpenApiCli(['--root', root, '--write'])).toBe(0)
    const pageFile = join(root, 'ui/workers/index.ts')
    await writeFile(pageFile, (await readFile(pageFile, 'utf8')).replace("layout: ['name']", "uses: ['worker.name'], layout: ['name']"))
    const catalog = join(root, 'locales/en/domain.json')
    const data = JSON.parse(await readFile(catalog, 'utf8'))
    data['field.worker.deleted'] = 'name'
    await writeFile(catalog, JSON.stringify(data, null, 2))
    const files = ['config.ts', 'schema/worker.ts', 'access.ts', 'runtime.ts', 'schema.lock.json', 'locales/en/domain.json', 'ui/workers/index.ts', 'ui/workers/-detail.layout.ts', 'ui/-slots.ts']
    const before = await Promise.all(files.map(file => readFile(join(root, file), 'utf8')))
    server = await createServer({ root })
    const mcp = await server.workflow.call('validate', { instance: 'reference-parity' }) as { ok: boolean; errors: unknown[] }
    const ci = (await validateInstance(root)).flatMap(finding => finding.reference ? [finding.reference] : [])
    const shared = await validateReferenceSources(root)
    expect(shared.diagnostics).toHaveLength(1)
    expect(shared.diagnostics[0]).toMatchObject({ code: 'unknown-reference', kind: 'i18n', target: { entity: 'worker', field: 'deleted' } })
    expect(mcp.ok).toBe(false)
    expect(mcp.errors).toEqual(ci)
    const { spawnSync } = await import('node:child_process')
    const cli = spawnSync('bun', ['run', 'check'], { cwd: root, encoding: 'utf8' })
    expect(cli.status).toBe(1)
    const cliDiagnostics = cli.stderr.split('\n').find(line => line.startsWith('[{'))
    expect(JSON.parse(cliDiagnostics!)).toEqual(mcp.errors)
    expect(ci).toEqual(shared.diagnostics)
    const removal = await validateReferenceSources(root, { kind: 'remove_field', entity: 'worker', field: 'name' })
    expect(removal.diagnostics.filter(d => d.code === 'removal-reference').map(d => d.kind)).toEqual(expect.arrayContaining(['display', 'list-column', 'layout', 'uses', 'i18n']))
    const entityRemoval = await validateReferenceSources(root, { kind: 'remove_entity', entity: 'worker' })
    expect(entityRemoval.diagnostics.filter(d => d.code === 'removal-reference').map(d => d.kind)).toEqual(expect.arrayContaining(['slot', 'nav', 'binding']))
    expect(await Promise.all(files.map(file => readFile(join(root, file), 'utf8')))).toEqual(before)
    const workerFile = join(root, 'schema/worker.ts')
    const worker = await readFile(workerFile, 'utf8')
    await writeFile(workerFile, worker.replace("read: 'allow'", "read: { where: { missing: { eq: 'name' } } }"))
    const invalidMcp = await server.workflow.call('validate', { instance: 'reference-parity' }) as { errors: unknown[] }
    const invalidCi = (await validateInstance(root)).flatMap(finding => finding.reference ? [finding.reference] : [])
    expect(invalidCi).toHaveLength(1)
    expect(invalidMcp.errors).toEqual(invalidCi)
    await writeFile(workerFile, worker)
  } finally { await server?.server.close(); await rm(root, { recursive: true, force: true }) }
})
