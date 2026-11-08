import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// Reused by the source regression and by an isolated packed-SDK consumer.
export async function checkMcpUpgrade(client: { callTool(input: { name: string; arguments: Record<string, unknown> }): Promise<any>; listTools(): Promise<any> }, root: string) {
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })).structuredContent
  const before = await readFile(join(root, 'config.ts'), 'utf8')
  const migrations = (await readdir(join(root, 'migrations'))).sort()
  const originalSql = await Promise.all(migrations.map(name => readFile(join(root, 'migrations', name), 'utf8')))
  const { tools } = await client.listTools()
  assert.match(tools.find((t: any) => t.name === 'propose_change').description, /set_display_field/)
  assert.match(tools.find((t: any) => t.name === 'validate').description, /instance/)
  const initial = await call('inspect_schema', { instance: 'workbase-test' })
  assert.equal(initial.ok, true)
  assert.equal(initial.revision, 3)
  assert.equal(initial.validation.ok, false)
  const invalid = await call('validate', { instance: 'workbase-test' })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.errors.length, 7)
  const changes = invalid.errors.map((error: any) => {
    assert.equal(error.code, 'invalid_display_field')
    assert.match(error.message, /set_display_field/)
    assert.equal(error.suggestedChange.kind, 'set_display_field')
    return error.suggestedChange
  })
  assert.equal(await readFile(join(root, 'config.ts'), 'utf8'), before, 'Inspection/validation must not auto-fix config')
  // An incomplete repair remains inspectable and cannot be applied or promoted.
  const partial = await call('propose_change', { instance: 'workbase-test', baseRevision: 3, changes: changes.slice(0, 1) })
  assert.equal(partial.ok, true)
  assert.equal((await call('validate', { proposalId: partial.proposalId })).errors.length, 6)
  assert.equal((await call('apply_to_disposable', { proposalId: partial.proposalId })).ok, false)
  assert.equal((await call('promote', { proposalId: partial.proposalId, expectedRevision: 3 })).ok, false)
  assert.equal(await readFile(join(root, 'config.ts'), 'utf8'), before)
  const proposal = await call('propose_change', { instance: 'workbase-test', baseRevision: 3, changes })
  assert.equal(proposal.ok, true)
  const proposalId = proposal.proposalId
  assert.equal((await call('validate', { proposalId })).ok, true)
  const preview = await call('preview_migration', { proposalId })
  assert.equal(preview.ok, true)
  assert.doesNotMatch(preview.sql, /\b(?:CREATE|ALTER|DROP|DELETE|UPDATE)\b/i)
  assert.match(preview.sql, /INSERT INTO instance_meta/)
  assert(preview.configDiff.filter((entry: any) => entry.path.endsWith('/displayField')).length === 7)
  // Replay the exact historical SQL, insert synthetic records, then apply the preview.
  const db = new DatabaseSync(':memory:')
  try {
    for (const sql of originalSql) db.exec(sql)
    db.exec("INSERT INTO organizations VALUES ('synthetic-org', 'Synthetic organization')")
    db.exec("INSERT INTO zakaznik (id, organization_id, created_at, updated_at, jmeno) VALUES ('synthetic-record', 'synthetic-org', '2026-01-01', '2026-01-01', 'Synthetic record')")
    const rows = db.prepare('SELECT * FROM zakaznik').all()
    const schema = db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all()
    db.exec(preview.sql)
    assert.deepEqual(db.prepare('SELECT * FROM zakaznik').all(), rows)
    assert.deepEqual(db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all(), schema)
  } finally { db.close() }
  assert.equal((await call('apply_to_disposable', { proposalId })).verified, true)
  const promoted = await call('promote', { proposalId, expectedRevision: 3 })
  assert.equal(promoted.ok, true, JSON.stringify(promoted))
  assert.equal(promoted.revision, 4)
  assert.equal(await readFile(join(root, 'migrations', promoted.migration), 'utf8'), preview.sql)
  assert.deepEqual(await Promise.all(migrations.map(name => readFile(join(root, 'migrations', name), 'utf8'))), originalSql)
  const history = JSON.parse(await readFile(join(root, 'config.versions.json'), 'utf8'))
  assert.deepEqual(history.map((v: any) => v.revision), [3, 4])
  for (const change of changes) {
    assert.equal(history[0].config.entities[change.entity].displayField, undefined)
    assert.equal(history[1].config.entities[change.entity].displayField, change.displayField)
  }
  assert.equal((await call('validate', { instance: 'workbase-test' })).ok, true)
  assert.equal((await call('inspect_schema', { instance: 'workbase-test' })).revision, 4)
  const versions = await call('list_versions', { instance: 'workbase-test' })
  assert.equal(versions.ok, true)
  assert(versions.versions.find((v: any) => v.revision === 3).rollback.blocked.length > 0, 'Invalid historical config must not become a valid rollback target')
  console.log('SDK upgrade MCP smoke: 0.2.1 revision 3 → 7 diagnostics → set_display_field → valid revision 4; no DDL; data/history preserved')
}
