import { registerTempDir, cleanupTempDir } from '../../../scripts/lib/test-temp-dir.mjs'
import { afterEach, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defineInstance, Fn, Q } from '@workbasehq/core/config'
import { versionData, diffVersions } from '@workbasehq/core/migrations/versions'
import { initialSchema } from '@workbasehq/core/migrations/schema'
import { configSource } from '../src/storage'
import { prepare } from '../src/planning'
import { changeSchema } from '../src/schemas'
import { createServer } from '../src/server'
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) cleanupTempDir(root) })
const fixture = () => defineInstance({ id: 'computed_fixture', revision: 1, roles: ['owner'], permissions: { owner: { rezervace: ['read'], zakaznik: ['read'], sluzba: ['read'] } }, entities: {
  zakaznik: { displayField: 'jmeno', fields: { jmeno: { type: 'string' } } }, sluzba: { displayField: 'nazev', fields: { nazev: { type: 'string' } } },
  rezervace: { displayField: 'title', fields: { title: { type: 'string' }, termin: { type: 'datetime' }, zakaznik: { type: 'ref', entity: 'zakaznik' }, sluzba: { type: 'ref', entity: 'sluzba' } } },
} })
const label = () => Fn.concat(Fn.strftime('%d. %m. %Y %H:%M', 'termin'), Q.value(' · '), 'zakaznik', Q.value(' · '), 'sluzba').serialize()
it('W44 Sample flow sets a serialized composite displayField, validates and previews only metadata SQL', async () => {
  const root = registerTempDir(await mkdtemp(join(tmpdir(), 'workbase-computed-'))); roots.push(root)
  await symlink(resolve('node_modules'), join(root, 'node_modules')); await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await mkdir(join(root, 'migrations')); await writeFile(join(root, 'config.ts'), configSource(fixture()))
  await writeFile(join(root, 'migrations/0001_initial.sql'), initialSchema(fixture()))
  const app = await createServer({ root }); const client = new Client({ name: 'sample-fixture', version: '1' }); const [a,b] = InMemoryTransport.createLinkedPair()
  try {
    await app.server.connect(b); await client.connect(a)
    expect((await client.listTools()).tools.find(tool => tool.name === 'propose_change')?.description).toContain('add_computed_field')
    const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })).structuredContent as any
    const schema = await call('inspect_schema', { instance: 'computed-fixture' }); expect(schema.revision).toBe(1)
    const proposal = await call('propose_change', { instance: 'computed-fixture', baseRevision: 1, changes: [
      { kind: 'set_display_field', entity: 'rezervace', displayField: label() },
      { kind: 'add_computed_field', entity: 'rezervace', field: 'caption', definition: { type: 'string', computed: Fn.concat('title', Q.value('!')).serialize() } },
    ] }); expect(proposal.ok).toBe(true)
    expect(await call('validate', { proposalId: proposal.proposalId })).toMatchObject({ ok: true, errors: [] })
    const preview = await call('preview_migration', { proposalId: proposal.proposalId }); expect(preview.ok).toBe(true)
    expect(preview.sql).not.toMatch(/CREATE|ALTER|DROP|UPDATE|DELETE/i)
    expect(preview.configDiff.some((patch: any) => patch.path.includes('computed'))).toBe(true)
  } finally { await client.close(); await app.server.close() }
})
it('W44 add/modify computed fields keep physical columns and reject stored conversion with suggested fix', () => {
  const added = prepare(fixture(), [], [changeSchema.parse({ kind: 'add_computed_field', entity: 'rezervace', field: 'caption', definition: { type: 'string', computed: Fn.concat('title', Q.value('!')).serialize() } })])
  const updated = prepare(added.target, [], [changeSchema.parse({ kind: 'set_computed_field', entity: 'rezervace', field: 'caption', computed: Fn.concat('title', Q.value('?')).serialize() })])
  expect(diffVersions(versionData(fixture()), versionData(updated.target))).toContainEqual(expect.objectContaining({ kind: 'field', path: 'entities.rezervace.fields.caption', change: 'added' }))
  expect(updated.sql).not.toMatch(/CREATE|ALTER|DROP|UPDATE|DELETE/i)
  expect(() => prepare(fixture(), [], [changeSchema.parse({ kind: 'set_computed_field', entity: 'rezervace', field: 'title', computed: label() })])).toThrow(/add_computed_field.*new field name/)
  expect(() => prepare(fixture(), [], [changeSchema.parse({ kind: 'set_display_field', entity: 'rezervace', displayField: Q.raw('title').serialize() })])).toThrow(/Fix:/)
})
