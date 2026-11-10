import { registerTempDir, cleanupTempDir } from '../../../scripts/lib/test-temp-dir.mjs'
import { afterEach, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defineInstance, cloneInstanceConfig, Fn, Q } from '@workbasehq/core/config'
import { initialSchema, revisionSQL } from '@workbasehq/core/migrations/schema'
import { prepare } from '../src/planning'
import { changeSchema } from '../src/schemas'
import { configSource } from '../src/storage'
import { createServer } from '../src/server'

const fixture = () => defineInstance({ id: 'label_fixture', revision: 1, roles: ['owner'],
  entities: { rezervace: { fields: { title: { type: 'string', required: true } } }, other: { fields: { title: { type: 'string' } } } },
  permissions: { owner: { rezervace: ['read', 'create'], other: ['read'] } },
  enumLabels: { en: { entity_rezervace: 'Bookings' }, cs: { value_pending: 'Čeká' } },
})
const captions = [
  { kind: 'set_label', entity: 'rezervace', language: 'cs', singular: 'rezervace', plural: 'Rezervace', object: 'rezervaci' },
  { kind: 'set_label', entity: 'rezervace', field: 'title', language: 'cs', label: 'Název rezervace' },
]
it('set_label writes existing translation keys without changing identifiers or migrating schema or records', () => {
  const config = fixture(), before = cloneInstanceConfig(config)
  const result = prepare(config, [], captions.map(value => changeSchema.parse(value)))
  expect(result.target.enumLabels).toEqual({ en: { entity_rezervace: 'Bookings' }, cs: {
    value_pending: 'Čeká', entity_rezervace: 'Rezervace', entitySingular_rezervace: 'rezervace', entityObject_rezervace: 'rezervaci', field_title_rezervace: 'Název rezervace',
  } })
  expect(result.target.entities).toEqual(config.entities)
  expect(result.sql.replace(/^--[^\n]*\n/gm, '').trim()).toBe(revisionSQL(2))
  expect(result.indexes).toEqual([])
  expect(config).toEqual(before)
})
it('set_label initializes dictionaries, updates one form and labels system fields and newly added fields', () => {
  const config = fixture(); delete config.enumLabels
  const changes = [captions[0], { ...captions[0], singular: 'Rezervace', plural: undefined, object: undefined },
    { ...captions[1], field: 'id', label: 'Číslo' },
    { kind: 'add_field', entity: 'rezervace', field: 'note', definition: { type: 'text' } }, { ...captions[1], field: 'note', label: 'Poznámka' }]
  expect(prepare(config, [], changes.map(value => changeSchema.parse(value))).target.enumLabels?.cs).toMatchObject({ entitySingular_rezervace: 'Rezervace', entityObject_rezervace: 'rezervaci', field_id_rezervace: 'Číslo', field_note_rezervace: 'Poznámka' })
})
it.each([false, true])('set_display_field and set_label compose on generated computed_display (replacing=%s)', replacing => {
  const config = defineInstance({ id: 'batch_repro', revision: 1, roles: ['owner'],
    entities: { bookings: { fields: { title: { type: 'string', required: true } },
      ...(replacing ? { displayField: Fn.concat('title', Q.value('?')).serialize() } : {}) } },
    permissions: { owner: { bookings: ['read'] } }, policies: { bookings: { owner: 'all' } },
  })
  const before = cloneInstanceConfig(config)
  const expression = Fn.concat('title', Q.value('!')).serialize()
  const result = prepare(config, [], [
    { kind: 'set_display_field', entity: 'bookings', displayField: expression },
    { kind: 'set_label', entity: 'bookings', field: 'computed_display', language: 'cs', label: 'Popis rezervace' },
  ])
  expect(result.target.entities.bookings).toMatchObject({ displayField: 'computed_display', displayExpression: expression,
    fields: { computed_display: { computed: expression, readOnly: true } } })
  expect(result.target.enumLabels?.cs?.field_computed_display_bookings).toBe('Popis rezervace')
  expect(result.sql.replace(/^--[^\n]*\n/gm, '').trim()).toBe(revisionSQL(2))
  expect(config).toEqual(before)
})
it.each([
  [{ ...captions[0], entity: 'missing' }, 'unknown_entity'],
  [{ ...captions[1], entity: 'missing' }, 'unknown_entity'],
  [{ ...captions[1], field: 'missing' }, 'unknown_field'],
  [{ ...captions[1], field: 'computed_display' }, 'unknown_field'],
])('set_label rejects unknown targets %j', (change, code) => {
  expect(() => prepare(fixture(), [], [changeSchema.parse(change)])).toThrow(expect.objectContaining({ code }))
})
it.each([
  { ...captions[0], singular: '' }, { ...captions[0], plural: '   ' }, { ...captions[0], object: '' },
  { ...captions[1], label: '' }, { ...captions[1], label: '\t\n' },
  { kind: 'set_label', entity: 'rezervace', language: 'cs' },
  { ...captions[1], singular: 'Mixed target' }, { ...captions[0], language: 'de' },
  { ...captions[1], label: undefined }, { ...captions[0], label: 'No field' },
])('set_label rejects empty captions, ambiguous targets and unsupported languages %j', change => {
  expect(changeSchema.safeParse(change).success).toBe(false)
})
it('set_locale changes locale and default language independently and preserves UI hints', () => {
  let config = fixture()
  config.ui = { entities: { rezervace: { list: { columns: ['title'] } } } }
  const next = (value: unknown) => {
    const result = prepare(config, [], [changeSchema.parse(value)])
    expect(result.sql.replace(/^--[^\n]*\n/gm, '').trim()).toBe(revisionSQL(config.revision + 1))
    expect(result.target.entities).toEqual(config.entities)
    return result.target
  }
  config = next({ kind: 'set_locale', locale: 'cs' })
  expect(config.locale).toBe('cs'); expect(config.ui?.defaultLanguage).toBeUndefined()
  config = next({ kind: 'set_locale', defaultLanguage: 'en' })
  expect(config.locale).toBe('cs'); expect(config.ui).toEqual({ defaultLanguage: 'en', entities: { rezervace: { list: { columns: ['title'] } } } })
  delete config.ui
  expect(next({ kind: 'set_locale', defaultLanguage: 'cs' }).ui).toEqual({ defaultLanguage: 'cs', entities: {} })
})
it.each(['en', 'cs'] as const)('caption and locale language %s matches core and preserves other dictionaries', language => {
  const config = fixture(), before = cloneInstanceConfig(config)
  const result = prepare(config, [], [
    changeSchema.parse({ kind: 'set_label', entity: 'other', language, field: 'title', label: 'Custom title' }),
    changeSchema.parse({ kind: 'set_locale', locale: language, defaultLanguage: language }),
  ])
  expect(defineInstance(result.target).locale).toBe(language)
  expect(result.target.ui?.defaultLanguage).toBe(language)
  expect(result.target.enumLabels?.[language]?.field_title_other).toBe('Custom title')
  expect(result.target.enumLabels?.[language]?.field_title_rezervace).toBeUndefined()
  for (const [key, labels] of Object.entries(before.enumLabels!)) expect(result.target.enumLabels?.[key]).toMatchObject(labels)
  expect(config).toEqual(before)
})
it.each([{ kind: 'set_locale' }, { kind: 'set_locale', locale: 'de' }, { kind: 'set_locale', defaultLanguage: '' }, { kind: 'set_locale', defaultLanguage: 'cs-CZ' }])('set_locale rejects unsupported or absent settings %j', change => {
  expect(changeSchema.safeParse(change).success).toBe(false)
})

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) cleanupTempDir(root) })
it('Sample captions and Czech locale complete propose validate preview disposable verify promote and reload', async () => {
  const root = registerTempDir(await mkdtemp(join(tmpdir(), 'workbase-labels-'))); roots.push(root)
  await symlink(resolve('node_modules'), join(root, 'node_modules')); await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await mkdir(join(root, 'migrations')); await writeFile(join(root, 'config.ts'), configSource(fixture()))
  await writeFile(join(root, 'migrations/0001_initial.sql'), initialSchema(fixture()))
  const app = await createServer({ root }), client = new Client({ name: 'sample-labels', version: '1' }), [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await app.server.connect(b); await client.connect(a)
    const tools = await client.listTools()
    expect(tools.tools.find(tool => tool.name === 'propose_change')?.description).toContain('set_label')
    const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 })).structuredContent as any
    const inspected = await call('inspect_schema', { instance: 'label-fixture' }); expect(inspected.revision).toBe(1)
    for (const [change, code] of [[{ ...captions[1], field: 'missing' }, 'unknown_field'], [{ ...captions[0], entity: 'missing' }, 'unknown_entity'], [{ ...captions[1], label: '' }, 'invalid_input'], [{ kind: 'set_locale', locale: 'de' }, 'invalid_input']] as const) {
      expect(await call('propose_change', { instance: 'label-fixture', baseRevision: 1, changes: [change] })).toMatchObject({ ok: false, error: { code } })
    }
    const proposal = await call('propose_change', { instance: 'label-fixture', baseRevision: 1, changes: [...captions, { kind: 'set_locale', locale: 'cs', defaultLanguage: 'cs' }] })
    expect(proposal.ok).toBe(true)
    const args = { proposalId: proposal.proposalId }
    expect(await call('promote', { ...args, expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: 'validation_required' } })
    expect(await call('validate', args)).toMatchObject({ ok: true, errors: [] })
    expect(await call('promote', { ...args, expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: 'verification_required' } })
    const preview = await call('preview_migration', args)
    expect(preview.sql.replace(/^--[^\n]*\n/gm, '').trim()).toBe(revisionSQL(2))
    expect(await call('apply_to_disposable', args)).toEqual({ ok: true, verified: true, diffs: [] })
    const promoted = await call('promote', { ...args, expectedRevision: 1 }); expect(promoted).toMatchObject({ ok: true, revision: 2, appliesToDatabase: false })
    expect(await readFile(join(root, 'migrations', promoted.migration), 'utf8')).toBe(preview.sql)
    const persisted = (await app.store.load('label-fixture')).config
    expect(persisted.enumLabels?.cs).toMatchObject({ entityObject_rezervace: 'rezervaci', field_title_rezervace: 'Název rezervace' })
    expect(persisted.locale).toBe('cs'); expect(persisted.ui?.defaultLanguage).toBe('cs')
    expect(await call('inspect_schema', { instance: 'label-fixture' })).toMatchObject({ locale: 'cs', ui: { defaultLanguage: 'cs' }, enumLabels: persisted.enumLabels, revision: 2 })
  } finally { await client.close(); await app.server.close() }
})
