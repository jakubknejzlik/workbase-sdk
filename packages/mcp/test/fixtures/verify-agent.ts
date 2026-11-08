import assert from 'node:assert/strict'
import { readFile, readdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

// Intentionally independent of the MCP workflow, its validator, and its planner.
export async function verifyAgent(root: string) {
  const dir = join(root, 'examples/disposable-sample-agent')
  const template = join(root, 'packages/mcp/test/fixtures/template')
  const read = async (path: string) => JSON.parse(await readFile(path, 'utf8'))
  const baseline = await read(join(template, 'config.json'))
  const marker = await read(join(dir, '.mcp-template.json'))
  assert.equal(marker.createdBy, 'workbase-mcp')
  assert.equal(marker.template, 'sample-v3')
  assert.equal(marker.initialRevision, baseline.revision)
  const source = await readFile(join(dir, 'config.ts'), 'utf8')
  const match = source.match(/export default defineInstance\((\{[\s\S]*\})\)\s*$/)
  assert.ok(match, 'Expected materialized config data in defineInstance')
  // Explicit plugin references are the only executable values in generated configs.
  // Inspect independently without evaluating instance code.
  const pluginList = match[1].match(/^\{\n  plugins: \[([^\n]*)\],/)
  if (baseline.plugins) {
    const expected = baseline.plugins.map((plugin: { name: string; configuration?: unknown }) => {
      const factories: Record<string, string> = { identity: 'identity', members: 'members', organizations: 'organizations', 'local-auth': 'localAuth', sample: 'samplePlugin' }
      if (factories[plugin.name] && (plugin.configuration !== undefined || ['sample'].includes(plugin.name))) return `${factories[plugin.name]}(${plugin.configuration === undefined || plugin.name === 'members' ? '' : JSON.stringify(plugin.configuration)})`
      if (plugin.name === 'permissions') return `permissions(${plugin.configuration === undefined ? '' : JSON.stringify(plugin.configuration)})`
      if (plugin.name === 'machine-credentials') return 'machineCredentials()'
      if (plugin.name === 'mail-outbox') return 'mailOutbox()'
      if (plugin.name === 'audit') return 'audit()'
      if (plugin.name === 'console') return "consoleUI({ history })"
      return plugin.name === 'local-auth' ? 'localAuth' : plugin.name
    }).join(', ')
    assert.equal(pluginList?.[1], expected)
  }
  const config = JSON.parse(match[1].replace(/^\{\n  plugins: \[[^\n]*\],/, '{'))
  assert.equal(config.revision, baseline.revision + 1, 'Revision must increase exactly once')
  assert.equal(config.entities.jobs.fields.notes.type, 'text')
  assert.equal(config.entities.jobs.fields.notes.required, false)
  assert.ok(!Object.hasOwn(baseline.entities.jobs.fields, 'notes'), 'Template already has notes')
  const baselineFiles = (await readdir(join(template, 'migrations'))).sort()
  const currentFiles = (await readdir(join(dir, 'migrations'))).sort()
  const migrations = []
  for (const name of baselineFiles) {
    const sql = await readFile(join(template, 'migrations', name), 'utf8')
    migrations.push({ name, sql })
    assert.equal(await readFile(join(dir, 'migrations', name), 'utf8'), sql, 'Existing migrations must remain intact')
  }
  const expectedHash = createHash('sha256').update(JSON.stringify({ config: baseline, migrations })).digest('hex')
  assert.equal(marker.initialHash, expectedHash, 'Creation marker must match the immutable template')
  const added = currentFiles.filter(name => !baselineFiles.includes(name))
  assert.equal(added.length, 1, 'Expected exactly one new migration')
  const sql = await readFile(join(dir, 'migrations', added[0]), 'utf8')
  assert.match(sql, /ALTER\s+TABLE\s+"?jobs"?\s+ADD\s+COLUMN\s+"?notes"?\s+TEXT\s*;/i)
  assert.match(sql, new RegExp(`INSERT INTO instance_meta VALUES \\(${config.revision},`))
  const proposals = []
  for (const name of (await readdir(join(dir, 'proposals'))).filter(n => /^[a-f0-9-]+\.json$/.test(n))) proposals.push(await read(join(dir, 'proposals', name)))
  const promoted = proposals.filter(p => p.status === 'promoted')
  assert.equal(promoted.length, 1, 'Expected exactly one promoted proposal')
  const proposal = promoted[0]
  assert.equal(proposal.instance, 'disposable-sample-agent')
  assert.equal(proposal.baseRevision, baseline.revision)
  assert.equal(proposal.promotedRevision, config.revision)
  assert.equal(proposal.migration, added[0])
  assert.ok(proposal.validation?.fingerprint && proposal.validation?.planHash)
  assert.deepEqual(proposal.verification, proposal.validation, 'Verification must match validated inputs and SQL')
  const log = (await readFile(join(dir, 'proposals/log.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const calls = log.filter(entry => entry.proposalId === proposal.proposalId).map(entry => entry.tool)
  assert.deepEqual(calls, ['propose_change', 'validate', 'preview_migration', 'apply_to_disposable', 'promote'])
  return { ok: true, instance: 'disposable-sample-agent', revision: config.revision, migration: added[0], calls }
}
if (process.argv[1] && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))) {
  console.log(JSON.stringify(await verifyAgent(resolve(fileURLToPath(new URL('../../../../', import.meta.url).href))), null, 2))
}
