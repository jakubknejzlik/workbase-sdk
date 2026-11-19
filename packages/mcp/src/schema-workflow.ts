import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { loadConfig, decodeSource, SourceError } from '@workbasehq/core/schema/load'
import { checkSchema, parseLock } from '@workbasehq/core/migrations/schema-lock'
import { checkLinkage, plan } from '@workbasehq/core/migrations/schema-plan'
import { runOpenApiCli } from '@workbasehq/core/openapi/cli'
import { serializeAccessLock } from '@workbasehq/core/access/lock'
import { KernelRegistry } from '@workbasehq/core/kernel/registry'
import { replaceLiteral } from './composition/literal-edit'
import { replaySources } from './replay-sources'
import { parseRuntimeSource } from './composition/runtime-source'
import { hydrateRuntimePlugins } from './composition/registry'
import { stateRoot, applyDisposable } from './disposable'
import { expectedSnapshot, instanceMeta } from './offline'
import { Store, durableAtomic, json, noLink, type Bundle } from './storage'
import { fail, WorkflowError, type SchemaChange } from './schemas'
import { hash } from './planning'
import type { SchemaProposal } from './proposals'
import { promotionHash, submitChange } from './submit-change'
import type { GitHubConfiguration } from './github'

// Persist through the canonical proposal directory so revocation is durable
// before checking mutable application paths, even when config.ts is missing or unsafe.
const save = async (store: Store, proposal: SchemaProposal) => durableAtomic(join(await store.proposalDirectory(proposal.instance), 'proposals', `${proposal.proposalId}.json`), json(proposal))
function revision(bundle: Bundle, expected: number) {
  if (bundle.config.revision !== expected) fail('stale_revision', 'Instance revision changed; propose again', 409)
}
async function load(store: Store, instance: string) {
  const root = await store.directory(instance)
  const loaded = await loadConfig(join(root, 'config.ts'))
  if (loaded.config.baseline !== 'workbase-sdk') fail('schema_requires_v3', 'Constraint authoring requires authored V3 schema files', 409)
  return store.load(instance, { canonicalRuntime: true })
}
/** Edit only authored constraint literals, then delegate lock/SQL identity to the
 * shared schema planner. Neither the legacy editor nor runtime serialization is used. */
async function prepare(root: string, base: Bundle, changes: SchemaChange[]) {
  const inputs: Record<string, Buffer> = { ...await replaySources(root, { accessLock: true }), 'config.ts': await readFile(join(root, 'config.ts')) }
  const original = await loadConfig(join(root, 'config.ts'))
  const baseLock = decodeSource(inputs['schema.lock.json'], join(root, 'schema.lock.json'))
  try { checkSchema(original.config, parseLock(baseLock), original.sources) }
  catch (error) { throw new WorkflowError('invalid_schema', error instanceof Error ? error.message : 'The committed schema lock does not match authored sources', 422) }
  const files = new Map<string, string>()
  const seen = new Set<string>()
  for (const change of changes) {
    if (seen.has(change.entity)) fail('invalid_input', 'Provide only one set_constraints operation per entity')
    seen.add(change.entity)
    if (!Object.hasOwn(original.authoredAccess.entities, change.entity)) fail('unknown_entity', `Unknown authored entity: ${change.entity}`)
    const path = `schema/${change.entity}.ts`
    files.set(path, replaceLiteral(decodeSource(inputs[path], join(root, path)), ['constraints'], change.constraints, join(root, path), { insert: true }))
  }
  await mkdir(stateRoot, { recursive: true }); await noLink(stateRoot)
  const scratch = await realpath(await mkdtemp(join(stateRoot, 'schema-')))
  try {
    for (const [path, bytes] of Object.entries(inputs)) {
      await mkdir(dirname(join(scratch, path)), { recursive: true })
      await writeFile(join(scratch, path), files.get(path) ?? bytes)
    }
    const options = { sdkResolutionRoot: root }
    const edited = await loadConfig(join(scratch, 'config.ts'), { ...options, bindExistingLock: false })
    const baseMigrations = Object.fromEntries(base.migrations.map(m => [m.name, m.sql]))
    const planned = await plan({ config: edited.config, sources: edited.sources, baseLock, baseMigrations }).catch(error => {
      throw new WorkflowError('invalid_schema', error instanceof Error ? error.message.replaceAll(scratch, root) : 'Could not plan the authored constraints', 422)
    })
    if (!planned.bundle) fail('no_schema_change', 'The constraints already match the committed schema')
    await checkLinkage(baseLock, baseMigrations, planned.lock, { ...baseMigrations, [planned.bundle.filename]: planned.bundle.sql })
    files.set('schema.lock.json', planned.lock)
    await writeFile(join(scratch, 'schema.lock.json'), planned.lock)
    const loaded = await loadConfig(join(scratch, 'config.ts'), options)
    const model = parseRuntimeSource(base.runtimeSource!)
    const runtime = { ...loaded.config, ...(model.interactive === undefined ? {} : { interactive: model.interactive }), plugins: hydrateRuntimePlugins(model, loaded.config) }
    const sources = Object.fromEntries(Object.entries(loaded.sources).map(([key, location]) => [key, { ...location, file: join(root, relative(scratch, location.file)) }]))
    const access = serializeAccessLock(new KernelRegistry(runtime), { root, sources })
    files.set('access.lock.json', access.json); files.set('access.lock.md', access.md)
    if (inputs['openapi.json']) {
      await runOpenApiCli(['--root', scratch, '--write'], options, { info: () => {}, error: message => console.error(message) })
      files.set('openapi.json', await readFile(join(scratch, 'openapi.json'), 'utf8'))
    }
    files.set(`migrations/${planned.bundle.filename}`, planned.bundle.sql)
    return { target: loaded.config, runtime, indexes: base.indexes, sql: planned.bundle.sql, migration: planned.bundle.filename,
      files: [...files].map(([path, data]) => ({ path, data })) }
  } catch (error) {
    if (error instanceof SourceError) {
      const location = { ...error.location, file: join(root, relative(scratch, error.location.file)) }
      const diagnostic = new SourceError(location, error.message.replace(/^.*?:\d+:\d+: /, ''))
      throw new WorkflowError('invalid_schema', diagnostic.message, 422, location)
    }
    throw error
  } finally { await rm(scratch, { recursive: true, force: true }) }
}
function proof(base: Bundle, prepared: Awaited<ReturnType<typeof prepare>>, changes: SchemaChange[]) {
  return { fingerprint: base.fingerprint, planHash: hash({ files: prepared.files, changes }), ...(base.dependencyDigest === undefined ? {} : { dependencyDigest: base.dependencyDigest }) }
}
export async function proposeSchema(store: Store, instance: string, baseRevision: number, changes: SchemaChange[], proposalId: string) {
  const base = await load(store, instance)
  revision(base, baseRevision)
  await prepare(await store.directory(instance), base, changes)
  const proposal: SchemaProposal = { kind: 'schema_change', instance, baseRevision, changes, proposalId, createdAt: new Date().toISOString(), status: 'proposed' }
  await save(store, proposal)
  return { ok: true, kind: proposal.kind, proposalId, baseRevision, status: proposal.status }
}
export async function executeSchema(store: Store, proposal: SchemaProposal, name: string,
  input: { expectedRevision?: number; expectedBaseSha?: string; keep?: boolean }, recover: () => Promise<void>, signal?: AbortSignal, github?: GitHubConfiguration) {
  if (name === 'submit_change') {
    await recover()
    return submitChange(await store.directory(proposal.instance), proposal, input.expectedBaseSha!, github, () => store.dependencyDigest(proposal.instance))
  }
  if (proposal.status === 'promoted' || proposal.status === 'discarded' && name !== 'discard') fail('proposal_closed', `Proposal is ${proposal.status}`, 409)
  // Revoke previous authorization before parsing any mutable source or lock.
  if (name === 'validate' || name === 'apply_to_disposable') {
    delete proposal.verification
    if (name === 'validate') delete proposal.validation
    proposal.status = proposal.validation ? 'validated' : 'proposed'
    await save(store, proposal)
  }
  await recover()
  if (name === 'discard') {
    proposal.status = 'discarded'; delete proposal.validation; delete proposal.verification
    await save(store, proposal)
    return { ok: true, status: proposal.status }
  }
  const root = await store.directory(proposal.instance)
  const base = await load(store, proposal.instance).catch(error => {
    if (name === 'promote' && proposal.validation) fail('stale_revision', 'Instance sources or lock changed since validation', 409)
    throw error
  })
  revision(base, proposal.baseRevision)
  if (name === 'promote') {
    revision(base, input.expectedRevision!)
    if (proposal.validation && proposal.validation.fingerprint !== base.fingerprint) fail('stale_revision', 'Instance files changed since validation', 409)
  }
  const prepared = await prepare(root, base, proposal.changes)
  const currentProof = proof(base, prepared, proposal.changes)
  if (name !== 'validate' && (!proposal.validation || hash(proposal.validation) !== hash(currentProof))) fail('validation_required', 'Validate this exact schema proposal against current files first', 409)
  await instanceMeta(base)
  const expected = await expectedSnapshot({ ...base, runtime: prepared.runtime }, prepared)
  if (name === 'validate') {
    proposal.validation = currentProof; proposal.status = 'validated'; await save(store, proposal)
    return { ok: true, kind: proposal.kind, revision: prepared.target.revision, errors: [] }
  }
  if (name === 'preview_migration') return { ok: true, kind: proposal.kind, revision: prepared.target.revision, sql: prepared.sql, files: prepared.files }
  if (name === 'apply_to_disposable') {
    const verification = await applyDisposable({ ...base, runtime: prepared.runtime }, prepared, expected, input.keep ?? false, signal)
    if (verification.verified) { proposal.verification = currentProof; proposal.status = 'verified' }
    await save(store, proposal)
    return { ok: verification.verified, ...verification }
  }
  if (name === 'promote') {
    if (!proposal.verification || hash(proposal.verification) !== hash(currentProof)) fail('verification_required', 'Apply and verify this exact schema on a disposable D1 first', 409)
    const latest = await load(store, proposal.instance)
    if (latest.fingerprint !== base.fingerprint) fail('stale_revision', 'Instance files changed since verification', 409)
    proposal.status = 'promoted'; proposal.promotedRevision = prepared.target.revision; proposal.migration = prepared.migration
    proposal.promotedFiles = prepared.files
    proposal.migrationPreview = { sql: prepared.sql, configDiff: proposal.changes, revision: prepared.target.revision }
    if (base.dependencyDigest !== undefined) proposal.dependencyDigest = base.dependencyDigest
    proposal.promotionHash = promotionHash(proposal)
    await store.commit(proposal.instance, [...prepared.files.map(file => ({ ...file, ...(file.path.startsWith('migrations/') ? { create: true } : {}) })),
      { path: `proposals/${proposal.proposalId}.json`, data: json(proposal) }], latest.guards)
    return { ok: true, kind: proposal.kind, status: proposal.status, revision: prepared.target.revision, files: prepared.files.map(file => file.path), appliesToDatabase: false }
  }
  return fail('unknown_tool', 'Unknown tool', 404)
}
