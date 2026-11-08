import assert from 'node:assert/strict'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { defineInstance } from '@workbasehq/core/config'
import { initialSchema, revisionSQL } from '@workbasehq/core/migrations/schema'
import { createServer } from '../src/server'
import { configSource } from '../src/storage'
import { computedConfig } from '../../frontend-console/e2e/runtime/computed-config'

// Run under the same Node + tsx loader as the configuration MCP, before starting
// the browser Worker. Its only source of captions/language is the promoted config.
const root = process.argv[2]
await symlink(resolve('node_modules'), join(root, 'node_modules'))
await writeFile(join(root, 'package.json'), '{"type":"module"}')
const config = defineInstance({ ...computedConfig, locale: 'en', enumLabels: {} })
await mkdir(join(root, 'migrations')); await writeFile(join(root, 'config.ts'), configSource(config))
await writeFile(join(root, 'migrations/0001_initial.sql'), initialSchema(config))
const app = await createServer({ root }), client = new Client({ name: 'sample-browser', version: '1' })
const [a, b] = InMemoryTransport.createLinkedPair()
try {
  await app.server.connect(b); await client.connect(a)
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 })).structuredContent as any
    assert.equal(result.ok, true, JSON.stringify(result))
    return result
  }
  const schema = await call('inspect_schema', { instance: 'computed-fixture' })
  const proposal = await call('propose_change', { instance: 'computed-fixture', baseRevision: schema.revision, changes: [
    { kind: 'set_label', entity: 'rezervace', language: 'cs', singular: 'rezervace', plural: 'Rezervace', object: 'rezervaci' },
    { kind: 'set_label', entity: 'rezervace', field: 'computed_display', language: 'cs', label: 'Název rezervace' },
    { kind: 'set_label', entity: 'rezervace', field: 'termin', language: 'cs', label: 'Datum rezervace' },
    { kind: 'set_locale', locale: 'cs', defaultLanguage: 'cs' },
  ] })
  const args = { proposalId: proposal.proposalId }
  await call('validate', args)
  const preview = await call('preview_migration', args)
  assert.equal(preview.sql.replace(/^--[^\n]*\n/gm, '').trim(), revisionSQL(2))
  assert.deepEqual(await call('apply_to_disposable', args), { ok: true, verified: true, diffs: [] })
  assert.equal((await call('promote', { ...args, expectedRevision: schema.revision })).revision, 2)
  console.log('MCP captions: propose → validate → preview → disposable D1 verified → promote (revision 2)')
} finally { await client.close(); await app.server.close() }
