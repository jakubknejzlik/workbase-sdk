import { registerTempDir, cleanupTempDir } from './lib/test-temp-dir.mjs'
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { InMemoryTransport } from '../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js'
import { createServer } from '../packages/mcp/src/server.ts'
import { captureSdkInputs } from '../packages/mcp/src/sdk-target.ts'
import { parseProposal } from '../packages/mcp/src/proposals.ts'
import { digestBytes, inside } from '../packages/mcp/src/sdk-upgrade-protocol.ts'

// One real registry installation, from the frozen historical 0.2.9 inputs to
// published 0.2.10. The candidate bridge cannot satisfy this with producer 0.2.11.
const scratch = registerTempDir(await realpath(await mkdtemp(join(tmpdir(), 'workbase-mcp-upgrade-smoke-\uFFFD-'))))
const checkout = await realpath(resolve(import.meta.dirname, '..'))
assert(!inside(checkout, scratch))
const root = join(scratch, 'instance'), shutdown = new AbortController()
const stop = () => shutdown.abort(new Error('Upgrade target smoke stopped'))
const timer = setTimeout(stop, 300000)
process.once('SIGINT', stop); process.once('SIGTERM', stop)
let application: Awaited<ReturnType<typeof createServer>> | undefined
const client = new Client({ name: 'installed-target-acceptance', version: '1' })
try {
  await cp(join(checkout, 'packages/mcp/test/fixtures/sdk-upgrade/valid-0.2.9'), root, { recursive: true })
  // Only the producer loads this config here. D2 never copies node_modules and
  // installs all target dependencies into its own external consumer.
  await symlink(join(checkout, 'node_modules'), join(root, 'node_modules'))
  const before = await captureSdkInputs(root)
  application = await createServer({ root })
  const [local, remote] = InMemoryTransport.createLinkedPair()
  await application.server.connect(remote); await client.connect(local)
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: args }, undefined, { signal: shutdown.signal, timeout: 300000 })
    return response.structuredContent as Record<string, any>
  }
  const proposed = await call('upgrade_sdk', { instance: 'sdk-upgrade-fixture', baseRevision: 1, targetVersion: '0.2.10' })
  assert.equal(proposed.ok, true, JSON.stringify(proposed))
  const proposalId = proposed.proposalId
  // Apply performs fresh validation and full disposable verification itself.
  // Exercise a real consumer pathname containing U+FFFD, whose valid UTF-8
  // encoding must remain distinct from invalid bytes at evidence consumption.
  const previousTmpdir = process.env.TMPDIR
  process.env.TMPDIR = scratch
  let verified
  try { verified = await call('apply_to_disposable', { proposalId, keep: true }) }
  finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTmpdir
  }
  assert.deepEqual(verified, { ok: true, status: 'verified', verified: true, revision: 1, targetVersion: '0.2.10' })
  const proposal = parseProposal(JSON.parse(await readFile(join(root, 'proposals', `${proposalId}.json`), 'utf8')))
  assert(proposal.kind === 'sdk_upgrade' && proposal.evidence?.state === 'verified')
  const { evidence } = proposal, { result } = evidence
  assert.equal(result.coreVersion, '0.2.10'); assert.deepEqual(result.marker, { version: '0.2.10', revision: 1 })
  assert.equal(result.schema.status, 'pass'); assert.equal(result.schema.expected, result.schema.applied)
  assert.equal(result.plugins.expected, result.plugins.applied)
  assert.equal(evidence.archives.length, 3); assert.equal(evidence.installed.length, 3)
  assert.equal(result.identity.targetVersion, '0.2.10')
  assert.equal(result.identity.baseFingerprint, proposal.baseFingerprint)
  assert.equal(result.identity.baseDependencyDigest, proposal.baseDependencyDigest)
  assert.notEqual(evidence.targetDependencyDigest, proposal.baseDependencyDigest)
  assert.deepEqual(result.packages.map(pkg => [pkg.name, pkg.version]), ['core', 'plugins', 'mcp'].map(name => [`@workbasehq/${name}`, '0.2.10']))
  const consumer = resolve(result.packages[0].directory, '../../..')
  assert(!inside(checkout, consumer) && !inside(root, consumer))
  for (const path of Object.values(result.resolutions)) assert(inside(join(consumer, 'node_modules'), path))
  for (const file of Object.values(evidence.artifacts)) assert.equal(digestBytes(Buffer.from(file.data, 'base64')), file.sha256)
  const manifest = JSON.parse(Buffer.from(evidence.artifacts['package.json'].data, 'base64').toString('utf8'))
  for (const pkg of result.packages) assert.equal(manifest.dependencies[pkg.name], '0.2.10')
  const preview = await call('preview_migration', { proposalId })
  assert.equal(preview.ok, true, JSON.stringify(preview)); assert.equal(preview.revision, 1)
  assert.equal(digestBytes(preview.sql), result.stage.marker.sha256)
  const recordPath = join(root, 'proposals', `${proposalId}.json`), canonical = await readFile(recordPath)
  const offset = canonical.indexOf(Buffer.from('\uFFFD'))
  assert(offset >= 0, 'Real installed-target evidence must contain the U+FFFD consumer path')
  const malformed = Buffer.concat([canonical.subarray(0, offset), Buffer.from([0xff]), canonical.subarray(offset + 3)])
  assert(!malformed.equals(canonical))
  assert.equal(malformed.toString('utf8'), canonical.toString('utf8'))
  await writeFile(recordPath, malformed)
  assert.equal((await call('promote', { proposalId, expectedRevision: 1 })).error?.code, 'validation_required')
  assert.deepEqual(await captureSdkInputs(root), before)
  assert.deepEqual(await readFile(recordPath), malformed)
  await writeFile(recordPath, canonical)
  const promoted = await call('promote', { proposalId, expectedRevision: 1 })
  assert.equal(promoted.ok, true, JSON.stringify(promoted))
  assert.equal(promoted.status, 'promoted'); assert.equal(promoted.revision, 1); assert.equal(promoted.appliesToDatabase, false)
  const published = await captureSdkInputs(root)
  for (const [path, file] of Object.entries(evidence.artifacts)) assert.deepEqual(published[path], Buffer.from(file.data, 'base64'), path)
  for (const [path, bytes] of Object.entries(before)) if (!['package.json', 'bun.lock'].includes(path)) assert.deepEqual(published[path], bytes, path)
  assert.equal(Object.keys(published).length, Object.keys(before).length + 1)
  assert.equal((await call('submit_change', { proposalId, instance: 'sdk-upgrade-fixture', expectedBaseSha: 'a'.repeat(40) })).error?.code, 'sdk_upgrade_not_supported')
  const snapshot = parseProposal(JSON.parse(await readFile(recordPath, 'utf8')))
  assert.equal(snapshot.status, 'promoted')
  assert.equal(snapshot.kind, 'sdk_upgrade')
  assert.equal(snapshot.baseDependencyDigest, proposal.baseDependencyDigest)
  const restarted = await createServer({ root })
  try { assert.equal((await restarted.workflow.call('promote', { proposalId, expectedRevision: 1 })).ok, true) }
  finally { await restarted.server.close(); await restarted.idle() }
  assert.deepEqual(await captureSdkInputs(root), published)
  await assert.rejects(readFile(join(consumer, 'package.json')), { code: 'ENOENT' })
  console.log(JSON.stringify({ targetVersion: result.coreVersion, packages: result.packages, resolutions: result.resolutions,
    schema: result.schema, plugins: result.plugins, marker: result.marker, stagedHashes: Object.fromEntries(Object.entries(evidence.artifacts).map(([path, file]) => [path, file.sha256])),
    applicationBytesUnchanged: true, revisionUnchanged: true, exactArtifactsPromoted: true, promotionSurvivesRestart: true,
    consumerRemoved: true, invalidUtf8PromotionRejected: true }))
} finally {
  shutdown.abort()
  await client.close(); await application?.server.close(); await application?.idle()
  cleanupTempDir(scratch)
  clearTimeout(timer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop)
}
