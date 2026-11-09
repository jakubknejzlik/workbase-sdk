import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CORE_VERSION } from '@workbasehq/core/config'
import { Store, json } from '../src/storage.ts'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { Workflow } from '../src/workflow.ts'
import { captureSdkInputs, runSdkTarget } from '../src/sdk-target.ts'
import { parseProposal } from '../src/proposals.ts'
import { schemas, WorkflowError } from '../src/schemas.ts'
import { RegistrySdkError } from '../src/sdk-registry.ts'
import { copyHistoricalInstances } from './fixtures.ts'
import { targetProof } from './fixtures/sdk-upgrade-evidence.ts'

vi.mock('../src/sdk-target.ts', async original => ({ ...await original<typeof import('../src/sdk-target.ts')>(), runSdkTarget: vi.fn() }))
let scratch: string, root: string, store: Store, workflow: Workflow, proposalId: string
const call = (name: string, extra = {}, signal?: AbortSignal) => workflow.call(name, { proposalId, ...extra }, signal)
const path = () => join(root, 'proposals', `${proposalId}.json`)
const record = async () => JSON.parse(await readFile(path(), 'utf8'))
// Permission bits do not inject failures when CI runs as root. Preserve the
// original inode outside proposals so restoration retains the accepted bytes.
const unreadableFile = async (file: string) => {
  const backup = join(scratch, crypto.randomUUID())
  await fs.rename(file, backup)
  await fs.mkdir(file)
  await expect(readFile(file)).rejects.toMatchObject({ code: 'EISDIR' })
  return async () => { await rm(file, { recursive: true }); await fs.rename(backup, file) }
}
const seed = async () => {
  const bundle = await store.load('sample')
  proposalId = crypto.randomUUID()
  await writeFile(path(), json({ kind: 'sdk_upgrade', proposalId, instance: 'sample', baseRevision: 2,
    targetVersion: '0.2.10', status: 'proposed', createdAt: new Date().toISOString(),
    baseFingerprint: bundle.fingerprint, baseDependencyDigest: bundle.dependencyDigest }))
}
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'wb-sdk-upgrade-'))
  await writeFile(join(scratch, 'package.json'), '{"type":"module"}\n')
  await copyHistoricalInstances(scratch)
  root = await realpath(join(scratch, 'examples/sample'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', dependencies: Object.fromEntries(['core', 'plugins', 'mcp'].map(name => [`@workbasehq/${name}`, '0.2.1'])) }))
  await writeFile(join(root, 'bun.lock'), 'captured historical base lock\n')
  const sql = join(root, 'migrations/0001_initial.sql')
  await writeFile(sql, (await readFile(sql, 'utf8')).replaceAll(`'${CORE_VERSION}'`, "'0.2.1'"))
  store = new Store(root, new Set(['sample'])); await store.init(); workflow = new Workflow(store)
  vi.mocked(runSdkTarget).mockReset().mockImplementation(targetProof)
  await seed()
})
afterEach(async () => { vi.restoreAllMocks(); syncBuiltinESMExports(); await rm(scratch, { recursive: true, force: true }) })

it('exposes the exact target public contract (D3 main-base red)', () => {
  expect((schemas as Record<string, any>).upgrade_sdk?.safeParse({ instance: 'sample', baseRevision: 2, targetVersion: '0.2.10' }).success).toBe(true)
})
it('dispatches seeded SDK validation and apply to D2 (D3 main-base red)', async () => {
  const before = await captureSdkInputs(root)
  const results = [await call('validate'), await call('apply_to_disposable')]
  expect(results.map(result => (result.error as { code?: string } | undefined)?.code)).toEqual([undefined, undefined])
  expect(runSdkTarget).toHaveBeenCalledTimes(2)
  expect(await captureSdkInputs(root)).toEqual(before)
})
it('creates, validates, previews, verifies, revalidates and discards durable target-bound evidence', async () => {
  const before = await captureSdkInputs(root)
  const proposed = await workflow.call('upgrade_sdk', { instance: 'sample', baseRevision: 2, targetVersion: '0.2.10' })
  expect(proposed).toMatchObject({ ok: true, status: 'proposed', baseRevision: 2, targetVersion: '0.2.10' })
  proposalId = String(proposed.proposalId)
  expect(await call('preview_migration')).toMatchObject({ error: { code: 'validation_required' } })
  expect(await call('validate')).toMatchObject({ ok: true, status: 'validated', verified: false, revision: 2 })
  expect(parseProposal(await record())).toMatchObject({ status: 'validated', evidence: { state: 'validated', proposalId } })
  expect(await call('preview_migration')).toMatchObject({ ok: true, revision: 2, sql: expect.stringContaining('target 0.2.10') })
  expect(await call('apply_to_disposable', { keep: true })).toMatchObject({ ok: true, status: 'verified', verified: true, revision: 2 })
  const verified = await record()
  expect(verified.evidence.targetDependencyDigest).not.toBe(verified.baseDependencyDigest)
  expect(parseProposal(verified)).toEqual(verified)
  // Evidence survives restart without any scratch consumer or extra persistence.
  const restarted = new Store(root); await restarted.init(); workflow = new Workflow(restarted)
  expect(await call('preview_migration')).toMatchObject({ ok: true, revision: 2 })
  expect(await call('validate')).toMatchObject({ ok: true, status: 'validated', verified: false })
  expect((await record()).evidence.state).toBe('validated')
  expect(await call('discard')).toMatchObject({ ok: true, status: 'discarded' })
  expect((await record()).evidence).toBeUndefined()
  expect(await call('apply_to_disposable')).toMatchObject({ error: { code: 'proposal_closed' } })
  expect(await captureSdkInputs(root)).toEqual(before)
})
it.each(['submit_change'])('keeps %s blocked even after successful verification and with broken config', async name => {
  expect((await call('apply_to_disposable')).ok).toBe(true)
  const proof = await readFile(path())
  await writeFile(join(root, 'config.ts'), "throw new Error('must not import for SDK barrier')\n")
  expect(await call(name, name === 'promote' ? { expectedRevision: 2 } : { instance: 'sample', expectedBaseSha: 'a'.repeat(40) })).toMatchObject({ error: { code: 'sdk_upgrade_not_supported' } })
  expect(await readFile(path())).toEqual(proof)
})
it.each(['validate', 'apply_to_disposable', 'preview_migration', 'discard'])('revokes evidence before a broken config import on %s', async name => {
  expect((await call('apply_to_disposable')).ok).toBe(true)
  const broken = "throw new Error('invalid changed config')\nexport default {}\n"
  await writeFile(join(root, 'config.ts'), broken)
  const before = await captureSdkInputs(root)
  expect((await call(name)).ok).toBe(name === 'discard')
  expect(await record()).toMatchObject({ status: name === 'discard' ? 'discarded' : 'proposed' })
  expect((await record()).evidence).toBeUndefined()
  expect(await captureSdkInputs(root)).toEqual(before)
})
it.each(['validate', 'apply_to_disposable', 'preview_migration', 'discard'])('revokes evidence before missing config preflight on %s (review 1)', async name => {
  expect((await call('apply_to_disposable')).ok).toBe(true)
  const before = await captureSdkInputs(root), config = join(root, 'config.ts')
  await rm(config)
  const result = await call(name)
  if (name === 'discard') expect(result).toMatchObject({ ok: true, status: 'discarded' })
  else expect(result).toMatchObject({ ok: false, error: { code: 'invalid_instance_directory' } })
  expect(await record()).toMatchObject({ status: name === 'discard' ? 'discarded' : 'proposed' })
  expect((await record()).evidence).toBeUndefined()
  await writeFile(config, before['config.ts'])
  expect(await call('preview_migration')).toMatchObject({ error: { code: name === 'discard' ? 'proposal_closed' : 'validation_required' } })
  expect(runSdkTarget).toHaveBeenCalledTimes(1)
  if (name !== 'discard') expect(await call('apply_to_disposable')).toMatchObject({ ok: true, verified: true })
  expect(await captureSdkInputs(root)).toEqual(before)
})
it.each(['config.ts', 'config.v2.ts', 'package.json', 'bun.lock', 'migrations'])('revokes evidence before symlinked %s preflight (review 1)', async file => {
  expect((await call('apply_to_disposable')).ok).toBe(true)
  const before = await captureSdkInputs(root), input = join(root, file), outside = join(scratch, 'linked-input')
  // Moving the original preserves the exact file/directory bytes for restoration.
  await fs.rename(input, outside)
  await symlink(outside, input)
  expect(await call('validate')).toMatchObject({ ok: false, error: { code: 'unsafe_path' } })
  expect(await record()).toMatchObject({ status: 'proposed' })
  expect((await record()).evidence).toBeUndefined()
  await rm(input)
  await fs.rename(outside, input)
  expect(await call('preview_migration')).toMatchObject({ error: { code: 'validation_required' } })
  expect(runSdkTarget).toHaveBeenCalledTimes(1)
  expect(await call('apply_to_disposable')).toMatchObject({ ok: true, verified: true })
  expect(await captureSdkInputs(root)).toEqual(before)
})
it('revokes evidence before unreadable config preflight (review 1)', async () => {
  expect((await call('apply_to_disposable')).ok).toBe(true)
  const config = join(root, 'config.ts'), before = await captureSdkInputs(root)
  const restore = await unreadableFile(config)
  try {
    expect((await call('validate')).ok).toBe(false)
    expect((await record()).evidence).toBeUndefined()
  } finally { await restore() }
  expect(await call('preview_migration')).toMatchObject({ error: { code: 'validation_required' } })
  expect(runSdkTarget).toHaveBeenCalledTimes(1)
  expect(await captureSdkInputs(root)).toEqual(before)
})
it('revokes evidence before failed recovery preflight (review 1)', async () => {
  expect((await call('apply_to_disposable')).ok).toBe(true)
  const before = await captureSdkInputs(root), journal = join(root, 'proposals/.promotion.json')
  await writeFile(journal, '{"files":"invalid"}\n')
  expect(await call('validate')).toMatchObject({ error: { code: 'invalid_journal' } })
  expect(await record()).toMatchObject({ status: 'proposed' })
  expect((await record()).evidence).toBeUndefined()
  await rm(journal)
  expect(await call('preview_migration')).toMatchObject({ error: { code: 'validation_required' } })
  expect(runSdkTarget).toHaveBeenCalledTimes(1)
  expect(await captureSdkInputs(root)).toEqual(before)
})
it.each(['manifest key/spec', 'manifest spec', 'lock key/spec', 'lock spec', 'lock resolution'])('redacts rejected %s from response and evidence (review 1)', async source => {
  const secret = 'file:/private/REVIEW_SECRET'
  const entries = { [source.includes('key/spec') ? secret : 'unrelated']: secret }
  if (source.startsWith('manifest')) {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    Object.assign(manifest.dependencies, entries)
    await writeFile(join(root, 'package.json'), json(manifest))
  } else {
    await writeFile(join(root, 'bun.lock'), json({ workspaces: { '': source === 'lock resolution' ? {} : { dependencies: entries } },
      packages: source === 'lock resolution' ? { [secret]: [secret] } : {} }))
  }
  await seed()
  // Use the real D2 preflight, which must reject before any registry/network call.
  const actual = await vi.importActual<typeof import('../src/sdk-target.ts')>('../src/sdk-target.ts')
  vi.mocked(runSdkTarget).mockImplementationOnce(actual.runSdkTarget)
  const result = await call('validate')
  expect(result).toEqual({ ok: false, error: { code: 'registry_guard', status: 409, message: 'SDK registry dependency sources were rejected' } })
  expect(JSON.stringify(result)).not.toContain('REVIEW_SECRET')
  expect(await readFile(path(), 'utf8')).not.toContain('REVIEW_SECRET')
  expect((await record()).evidence).toBeUndefined()
})
it.each([
  ['registry_selection', 'SDK registry version selection failed'], ['registry_metadata', 'SDK registry metadata verification failed'],
  ['registry_install', 'SDK registry installation failed'], ['registry_integrity', 'SDK registry integrity verification failed'],
  ['registry_guard', 'SDK registry dependency sources were rejected'],
] as const)('redacts nested %s errors after verification (review 1)', async (code, message) => {
  expect((await call('apply_to_disposable')).ok).toBe(true)
  const cause = new Error('https://registry.invalid/REVIEW_SECRET?token=REVIEW_SECRET')
  vi.mocked(runSdkTarget).mockRejectedValueOnce(new RegistrySdkError(code, `file:/private/REVIEW_SECRET: ${cause.message}`, { cause }))
  const result = await call('validate')
  expect(result).toEqual({ ok: false, error: { code, status: 409, message } })
  expect(JSON.stringify(result)).not.toMatch(/REVIEW_SECRET|file:|https:|Registry SDK:/)
  expect(await readFile(path(), 'utf8')).not.toContain('REVIEW_SECRET')
  expect(await record()).toMatchObject({ status: 'proposed' })
  expect((await record()).evidence).toBeUndefined()
})
it.each(['package.json', 'bun.lock', 'config.ts', 'config.v2.ts', 'config.versions.json', 'config.indexes.json', 'migrations/0001_initial.sql'])('revokes old evidence after drift of %s', async file => {
  expect((await call('apply_to_disposable')).ok).toBe(true)
  const previous = await readFile(join(root, file)).catch(() => Buffer.from('[]'))
  await writeFile(join(root, file), Buffer.concat([previous, Buffer.from('\n')]))
  const before = await captureSdkInputs(root)
  for (const action of ['preview_migration', 'validate', 'apply_to_disposable']) {
    expect((await call(action)).ok).toBe(false)
    expect(await record()).toMatchObject({ status: 'proposed' })
    expect((await record()).evidence).toBeUndefined()
  }
  expect(await captureSdkInputs(root)).toEqual(before)
})
it.each(['install', 'verify'])('rejects base drift at a deterministic %s barrier before publishing any evidence', async phase => {
  const barrier = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
  const ready = barrier(), proceed = barrier()
  vi.mocked(runSdkTarget).mockImplementationOnce(async options => {
    // The real D2 checks at both phases are covered by sdk-target.test.
    ready.resolve(); await proceed.promise
    return targetProof(options)
  })
  const running = call('apply_to_disposable'); await ready.promise
  expect(await record()).toMatchObject({ status: 'proposed' })
  await writeFile(join(root, phase === 'install' ? 'package.json' : 'bun.lock'), 'changed at barrier')
  const before = await captureSdkInputs(root); proceed.resolve()
  expect((await running).ok).toBe(false)
  expect((await record()).evidence).toBeUndefined()
  expect(await captureSdkInputs(root)).toEqual(before)
})
it.each(['failure', 'cancel', 'wrong target', 'wrong revision', 'wrong artifact', 'missing package'])('revokes accepted proof on %s revalidation', async mode => {
  expect((await call('apply_to_disposable')).ok).toBe(true)
  const before = await captureSdkInputs(root), controller = new AbortController()
  vi.mocked(runSdkTarget).mockImplementationOnce(async options => {
    expect((await record()).evidence).toBeUndefined()
    if (mode === 'failure') throw new Error('verification failed')
    if (mode === 'cancel') controller.abort()
    const proof = await targetProof(options)
    if (mode === 'wrong target') proof.result.identity.targetVersion = '0.2.11'
    if (mode === 'wrong revision') proof.result.marker.revision++
    if (mode === 'wrong artifact') proof.artifacts['package.json'].bytes = Buffer.from('substitution')
    if (mode === 'missing package') proof.installed.pop()
    return proof
  })
  expect((await call('apply_to_disposable', {}, controller.signal)).ok).toBe(false)
  expect(await record()).toMatchObject({ status: 'proposed' })
  expect((await record()).evidence).toBeUndefined()
  expect(await captureSdkInputs(root)).toEqual(before)
})
it('revokes previous proof on an already-aborted call', async () => {
  expect((await call('apply_to_disposable')).ok).toBe(true)
  expect(await call('validate', {}, AbortSignal.abort())).toMatchObject({ error: { code: 'sdk_upgrade_cancelled' } })
  expect((await record()).evidence).toBeUndefined()
})
it.each(['cancel', 'input drift'])('revokes proof when %s occurs at evidence publication', async failure => {
  const controller = new AbortController(), rename = fs.rename
  let injected = false
  vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
    await rename(source, destination)
    if (!injected && String(destination) === path() && (await record()).evidence) {
      injected = true
      if (failure === 'cancel') controller.abort()
      else await writeFile(join(root, 'bun.lock'), 'external drift at publication')
    }
  })
  syncBuiltinESMExports()
  expect((await call('apply_to_disposable', {}, controller.signal)).ok).toBe(false)
  expect(injected).toBe(true)
  expect((await record()).evidence).toBeUndefined()
  expect((await record()).status).toBe('proposed')
})
it.each([
  ['0.2.1', 'sdk_upgrade_forward_required'], ['0.2.0', 'sdk_upgrade_forward_required'], ['1.0.0', 'sdk_upgrade_major_unsupported'],
  ['0.2.10-rc.1', 'sdk_upgrade_target_unsupported'], ['0.2.10+build', 'sdk_upgrade_target_unsupported'], ['latest', 'invalid_input'],
])('rejects execution target %s explicitly', async (targetVersion, code) => {
  expect(await workflow.call('upgrade_sdk', { instance: 'sample', baseRevision: 2, targetVersion })).toMatchObject({ error: { code } })
  expect(runSdkTarget).not.toHaveBeenCalled()
})
it('rejects nonstandalone producers', async () => {
  const multiple = new Store(scratch); await multiple.init()
  expect(await new Workflow(multiple).call('upgrade_sdk', { instance: 'sample', baseRevision: 2, targetVersion: '0.2.10' })).toMatchObject({ error: { code: 'sdk_upgrade_standalone_required' } })
})

it.each(['validate', 'preview_migration', 'discard'])('keeps %s independent of another Instance with unwritable proposals (review 4)', async action => {
  const multiple = new Store(scratch, new Set(['sample', 'secondary'])); await multiple.init()
  const configWorkflow = new Workflow(multiple)
  const proposed = await configWorkflow.call('propose_change', { instance: 'sample', baseRevision: 2,
    changes: [{ kind: 'add_field', entity: 'jobs', field: 'notes', definition: { type: 'text' } }] })
  expect(proposed.ok).toBe(true)
  const unrelated = join(scratch, 'examples/secondary/proposals')
  const before = await fs.readdir(unrelated)
  const backup = join(scratch, 'secondary-proposals')
  await fs.rename(unrelated, backup)
  await writeFile(unrelated, 'unwritable proposals parent\n')
  await expect(writeFile(join(unrelated, 'probe'), '')).rejects.toMatchObject({ code: 'ENOTDIR' })
  try {
    expect(await configWorkflow.call(action, { proposalId: proposed.proposalId })).toMatchObject({ ok: true })
    expect(await readFile(unrelated, 'utf8')).toBe('unwritable proposals parent\n')
  } finally { await rm(unrelated); await fs.rename(backup, unrelated) }
  expect(await fs.readdir(unrelated)).toEqual(before)
  for (const instance of ['sample', 'secondary']) {
    expect((await fs.readdir(join(scratch, 'examples', instance, 'proposals'))).filter(file => file.endsWith('.sdk-attempts.jsonl'))).toEqual([])
  }
})

it('creates no SDK attempt journals on a nonstandalone server (review 4)', async () => {
  const multiple = new Store(scratch, new Set(['sample', 'secondary'])); await multiple.init()
  expect(await new Workflow(multiple).call('validate', { proposalId })).toMatchObject({ error: { code: 'sdk_upgrade_standalone_required' } })
  for (const instance of ['sample', 'secondary']) {
    expect((await fs.readdir(join(scratch, 'examples', instance, 'proposals'))).filter(file => file.endsWith('.sdk-attempts.jsonl'))).toEqual([])
  }
  expect(runSdkTarget).not.toHaveBeenCalled()
})

it.each(['preview_migration', 'apply_to_disposable'])('rejects malformed UTF-8 with identical decoded evidence on %s (review 4)', async action => {
  vi.mocked(runSdkTarget).mockImplementationOnce(async options => {
    const proof = await targetProof(options)
    for (const pkg of proof.result.packages) pkg.directory = pkg.directory.replace('/removed-consumer', '/removed-consumer-\uFFFD')
    for (const key of Object.keys(proof.result.resolutions)) proof.result.resolutions[key] = proof.result.resolutions[key].replace('/removed-consumer', '/removed-consumer-\uFFFD')
    return proof
  })
  expect(await call('apply_to_disposable')).toMatchObject({ ok: true, verified: true })
  expect(await call('preview_migration')).toMatchObject({ ok: true })
  const canonical = await readFile(path()), offset = canonical.indexOf(Buffer.from('\uFFFD'))
  expect(offset).toBeGreaterThan(-1)
  const malformed = Buffer.concat([canonical.subarray(0, offset), Buffer.from([0xff]), canonical.subarray(offset + 3)])
  expect(malformed.equals(canonical)).toBe(false)
  expect(malformed.toString('utf8')).toBe(canonical.toString('utf8'))
  await writeFile(path(), malformed)
  expect(await call(action)).toMatchObject({ ok: false, error: { code: 'validation_required' } })
  expect((await record()).evidence).toBeUndefined()
  expect(runSdkTarget).toHaveBeenCalledTimes(1)
})

it.each(['validate', 'preview_migration', 'apply_to_disposable'])('revokes before unreadable audit and missing config on %s (review 2)', async action => {
  expect((await call('apply_to_disposable')).ok).toBe(true)
  const log = join(root, 'proposals/log.jsonl'), config = join(root, 'config.ts'), bytes = await readFile(config)
  const restore = await unreadableFile(log)
  await expect(fs.appendFile(log, '')).rejects.toMatchObject({ code: 'EISDIR' })
  await rm(config)
  try { expect(await call(action)).toMatchObject({ ok: false, error: { code: 'internal_error' } }) }
  finally { await restore(); await writeFile(config, bytes) }
  expect((await store.find(proposalId)).proposal.evidence).toBeUndefined()
  expect(await call('preview_migration')).toMatchObject({ error: { code: 'validation_required' } })
  expect(runSdkTarget).toHaveBeenCalledTimes(1)
})

// Every fallible exit between SDK discovery and execution in Workflow.call.
const earlyExits = [
  ['audit append', 'internal_error'], ['audit path', 'unsafe_path'], ['schema', 'invalid_input'],
  ['proposal read', 'internal_error'], ['proposal identity', 'invalid_proposal'], ['proposal parse', 'invalid_proposal'],
  ['recovery', 'invalid_journal'], ['config preflight', 'invalid_instance_directory'], ['cancellation', 'sdk_upgrade_cancelled'],
] as const
it.each(earlyExits)('revokes evidence on workflow exit: %s (review 2)', async (exit, code) => {
  expect((await call('apply_to_disposable')).ok).toBe(true)
  const before = await record(), config = join(root, 'config.ts'), configBytes = await readFile(config)
  const log = join(root, 'proposals/log.jsonl'), journal = join(root, 'proposals/.promotion.json')
  const restoreAudit = exit === 'audit append' ? await unreadableFile(log) : undefined
  if (restoreAudit) await expect(fs.appendFile(log, '')).rejects.toMatchObject({ code: 'EISDIR' })
  if (exit === 'audit path') { await rm(log); await symlink(join(scratch, 'outside-log'), log) }
  if (exit === 'proposal identity') await writeFile(path(), json({ ...before, proposalId: crypto.randomUUID() }))
  if (exit === 'proposal parse') await writeFile(path(), json({ ...before, unexpected: true }))
  if (exit === 'recovery') await writeFile(journal, '{')
  if (exit === 'config preflight') await rm(config)
  if (exit === 'proposal read') {
    const locked = store.lockedProposal.bind(store), read = fs.readFile
    let armed = false
    vi.spyOn(store, 'lockedProposal').mockImplementation((instance, fn) => locked(instance, (...args) => { armed = true; return fn(...args) }))
    vi.spyOn(fs, 'readFile').mockImplementation((...args: Parameters<typeof fs.readFile>) => {
      if (armed && String(args[0]).includes(proposalId)) { armed = false; return Promise.reject(new Error('REVIEW_SECRET read failure')) }
      return read(...args)
    })
    syncBuiltinESMExports()
  }
  let result
  try { result = await call('validate', exit === 'schema' ? { unexpected: true } : {}, exit === 'cancellation' ? AbortSignal.abort() : undefined) }
  finally {
    vi.restoreAllMocks(); syncBuiltinESMExports()
    await restoreAudit?.()
    if (exit === 'audit path') await rm(log)
    if (exit === 'recovery') await rm(journal)
    if (exit === 'config preflight') await writeFile(config, configBytes)
  }
  expect(result).toMatchObject({ ok: false, error: { code } })
  expect((await store.find(proposalId)).proposal.evidence).toBeUndefined()
  expect((await call('preview_migration')).ok).toBe(false)
  expect(runSdkTarget).toHaveBeenCalledTimes(1)
})

it.each(['marker', 'rewrite'])('fails closed when revocation %s fails, including the next read (review 2)', async failure => {
  expect((await call('apply_to_disposable')).ok).toBe(true)
  const link = fs.link, write = fs.writeFile
  if (failure === 'marker') vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
    if (String(from) === path()) throw new Error('REVIEW_SECRET revocation failure')
    return link(from, to)
  })
  else vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]).startsWith(path())) throw new Error('REVIEW_SECRET revocation failure')
    return write(...args)
  })
  syncBuiltinESMExports()
  const result = await call('validate')
  vi.restoreAllMocks(); syncBuiltinESMExports()
  expect(result).toMatchObject({ ok: false, error: { code: 'internal_error' } })
  // A fresh Store must also treat an interrupted revocation as unknown/revoked.
  const restarted = new Store(root); await restarted.init(); workflow = new Workflow(restarted)
  expect((await restarted.find(proposalId)).proposal.evidence).toBeUndefined()
  expect(await call('preview_migration')).toMatchObject({ error: { code: 'validation_required' } })
  expect(runSdkTarget).toHaveBeenCalledTimes(1)
})

it('revokes interrupted publication even when the cleanup rewrite fails (review 2)', async () => {
  const controller = new AbortController(), rename = fs.rename, write = fs.writeFile
  let published = false
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    await rename(from, to)
    if (String(to) === path() && (await record()).evidence) { published = true; controller.abort() }
  })
  vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
    if (published && String(args[0]).startsWith(path())) throw new Error('REVIEW_SECRET cleanup failure')
    return write(...args)
  })
  syncBuiltinESMExports()
  expect(await call('apply_to_disposable', {}, controller.signal)).toMatchObject({ ok: false, error: { code: 'internal_error' } })
  vi.restoreAllMocks(); syncBuiltinESMExports()
  expect(published).toBe(true)
  const restarted = new Store(root); await restarted.init(); workflow = new Workflow(restarted)
  expect((await restarted.find(proposalId)).proposal.evidence).toBeUndefined()
  expect(await call('preview_migration')).toMatchObject({ error: { code: 'validation_required' } })
})

it.each(['validate', 'preview_migration', 'apply_to_disposable', 'upgrade_sdk'])('redacts actual recovery conflict paths on %s (review 2)', async action => {
  expect((await call('apply_to_disposable')).ok).toBe(true)
  const moved = join(scratch, 'REVIEW_SECRET')
  await fs.rename(root, moved); root = moved
  store = new Store(root); await store.init(); workflow = new Workflow(store)
  await writeFile(join(root, 'proposals/.promotion.json'), json({ version: 2, files: [
    { path: 'bun.lock', before: Buffer.from('original').toString('base64'), afterHash: 'a'.repeat(64) },
  ] }))
  const result = action === 'upgrade_sdk'
    ? await workflow.call(action, { instance: 'sample', baseRevision: 2, targetVersion: '0.2.10' }) : await call(action)
  expect(result).toMatchObject({ ok: false, error: { code: 'concurrent_modification', status: 409, message: 'Instance files changed during the SDK operation' } })
  expect(JSON.stringify(result)).not.toMatch(/REVIEW_SECRET|\/proposals|\/private\/|\/tmp\//)
  for (const file of await fs.readdir(join(root, 'proposals'))) {
    if (file.includes(proposalId)) expect(await readFile(join(root, 'proposals', file), 'utf8')).not.toContain('REVIEW_SECRET')
  }
})

const sdkErrorCodes = [
  'registry_selection', 'registry_metadata', 'registry_install', 'registry_integrity', 'registry_guard',
  'sdk_upgrade_target_unsupported', 'sdk_upgrade_standalone_required', 'sdk_upgrade_base_changed', 'dependencies_changed',
  'sdk_upgrade_major_unsupported', 'sdk_upgrade_forward_required', 'sdk_upgrade_not_supported', 'sdk_upgrade_cancelled', 'sdk_upgrade_failed',
  'invalid_proposal', 'proposal_closed', 'validation_required', 'invalid_input', 'internal_error',
  'concurrent_modification', 'invalid_journal', 'unsafe_path', 'instance_busy', 'invalid_lock_claim', 'legacy_lock_claim',
  'invalid_instance_directory', 'instance_not_allowed', 'invalid_allowlist', 'proposal_not_found', 'invalid_instance_id',
  'invalid_migrations', 'invalid_indexes', 'invalid_config', 'unsupported_plugin_source', 'config_schema_mismatch',
  'migration_blocked', 'revision_mismatch', 'unknown_future_sdk_code',
]
it.each(['validate', 'preview_migration', 'apply_to_disposable', 'upgrade_sdk'])('redacts every SDK error code at the %s workflow boundary (review 2)', async action => {
  expect((await call('apply_to_disposable')).ok).toBe(true)
  const secret = `file:/private/REVIEW_SECRET ${root} https://registry.invalid/REVIEW_SECRET`
  for (const code of sdkErrorCodes) {
    const error = new WorkflowError(code, secret, 409, { path: secret, nested: { message: secret } })
    // Fail at acquisition, outside the target runner's own error handling.
    vi.spyOn(store, action === 'upgrade_sdk' ? 'locked' : 'lockedProposal').mockRejectedValueOnce(error)
    const result = action === 'upgrade_sdk'
      ? await workflow.call(action, { instance: 'sample', baseRevision: 2, targetVersion: '0.2.10' }) : await call(action)
    expect(result, code).toMatchObject({ ok: false, error: { code, status: 409 } })
    expect(Object.keys(result.error as object).sort(), code).toEqual(['code', 'message', 'status'])
    expect(JSON.stringify(result), code).not.toContain('REVIEW_SECRET')
    expect(JSON.stringify(result), code).not.toContain(root)
    for (const file of await fs.readdir(join(root, 'proposals'))) {
      if (file.includes(proposalId)) {
        const persisted = await readFile(join(root, 'proposals', file), 'utf8')
        expect(persisted, code).not.toContain('REVIEW_SECRET')
        expect(persisted, code).not.toContain(root)
      }
    }
  }
})

// A separate Node process has no Store caches or process-local revocation set.
function consumerProcess(action: string, pauseAtDiscovery = false) {
  const child = spawn(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), '--input-type=module', '-e', `
    import { Store } from ${JSON.stringify(resolve('packages/mcp/src/storage.ts'))};
    import { Workflow } from ${JSON.stringify(resolve('packages/mcp/src/workflow.ts'))};
    const store = new Store(${JSON.stringify(root)}); await store.init();
    if (${pauseAtDiscovery}) {
      store.find = async () => {
        process.send({ event: 'discovery' });
        await new Promise(() => { process.on('message', () => {}); });
      };
    }
    console.log(JSON.stringify(await new Workflow(store).call(${JSON.stringify(action)}, { proposalId: ${JSON.stringify(proposalId)} })));
  `], { env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], timeout: 15000 })
  let stdout = '', stderr = ''
  child.stdout!.on('data', bytes => { stdout += bytes })
  child.stderr!.on('data', bytes => { stderr += bytes })
  const closed = once(child, 'close')
  return { child, closed, result: async () => {
    const [code] = await closed
    expect(code, stderr).toBe(0)
    return JSON.parse(stdout)
  } }
}

it.each(['unreadable proposal', 'invalid lock claim'].flatMap(failure =>
  ['preview_migration', 'apply_to_disposable'].map(action => [failure, action])))('rejects %s after failed validation and restoration on %s (review 3)', async (failure, action) => {
  expect((await call('apply_to_disposable')).ok).toBe(true)
  const claim = join(root, 'proposals/.lock-claim')
  const restore = failure === 'unreadable proposal' ? await unreadableFile(path()) : undefined
  if (!restore) await writeFile(claim, '{')
  try { expect((await call('validate')).ok).toBe(false) }
  finally {
    if (restore) await restore()
    else await rm(claim)
  }
  expect((await call(action)).ok).toBe(false)
  expect(runSdkTarget).toHaveBeenCalledTimes(1)
})

it('durably invalidates the canonical record when both marker writes fail after acquisition (review 3)', async () => {
  expect((await call('apply_to_disposable')).ok).toBe(true)
  const marker = `${path()}.sdk-revoked`, link = fs.link, write = fs.writeFile
  // Fail only marker creation: the fallback must still write the canonical
  // inode under the acquired lock, as it can in an unwritable directory.
  const denied = () => Object.assign(new Error('Injected marker creation failure'), { code: 'EACCES' })
  const linkFault = vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
    if (String(to) === marker) throw denied()
    return link(from, to)
  })
  const writeFault = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]) === marker) throw denied()
    return write(...args)
  })
  syncBuiltinESMExports()
  await expect(fs.link(path(), marker)).rejects.toMatchObject({ code: 'EACCES' })
  await expect(writeFile(marker, '', { flag: 'wx' })).rejects.toMatchObject({ code: 'EACCES' })
  linkFault.mockClear(); writeFault.mockClear()
  expect(await call('validate')).toMatchObject({ ok: false, error: { code: 'internal_error' } })
  expect(linkFault.mock.calls.filter(([, to]) => String(to) === marker)).toHaveLength(1)
  expect(writeFault.mock.calls.filter(([file]) => String(file) === marker)).toHaveLength(1)
  vi.restoreAllMocks(); syncBuiltinESMExports()
  const invalidated = await record()
  expect((await consumerProcess('preview_migration').result()).ok).toBe(false)
  expect(invalidated.evidence).toBeUndefined()
})

it('rejects a crashed attempt in a fresh process before proposal discovery (review 3)', async () => {
  expect((await call('apply_to_disposable')).ok).toBe(true)
  const accepted = await readFile(path())
  const running = consumerProcess('validate', true)
  try {
    const event = await Promise.race([once(running.child, 'message'), running.closed.then(() => { throw new Error('Validation exited before discovery barrier') })])
    expect(event[0]).toEqual({ event: 'discovery' })
  } finally {
    running.child.kill('SIGKILL')
    await running.closed
  }
  expect(await readFile(path())).toEqual(accepted)
  const journal = await readFile(join(root, 'proposals', `${proposalId}.sdk-attempts.jsonl`), 'utf8').catch(() => '')
  expect((await consumerProcess('preview_migration').result()).ok).toBe(false)
  expect(JSON.parse(journal.trimEnd().split('\n').at(-1)!)).toMatchObject({ event: 'attempt-started', proposalId, attemptId: expect.any(String) })
})

it.each(['config.ts', 'bun.lock', 'proposal bytes', 'proposal metadata'].flatMap(input =>
  ['preview_migration', 'apply_to_disposable'].map(action => [input, action])))('binds %s at consumption without a revalidation call on %s (review 3)', async (input, action) => {
  expect((await call('apply_to_disposable')).ok).toBe(true)
  if (input === 'proposal metadata') await writeFile(path(), json({ ...await record(), createdAt: '2026-01-01T00:00:00.000Z' }))
  else if (input === 'proposal bytes') await fs.appendFile(path(), '\n')
  else await fs.appendFile(join(root, input), '\n')
  expect((await call(action)).ok).toBe(false)
  expect(runSdkTarget).toHaveBeenCalledTimes(1)
})

it('keeps successful bound evidence consumable in a fresh process (review 3)', async () => {
  expect((await call('apply_to_disposable')).ok).toBe(true)
  expect(await consumerProcess('preview_migration').result()).toMatchObject({ ok: true, targetVersion: '0.2.10' })
  expect(await call('apply_to_disposable')).toMatchObject({ ok: true, verified: true })
})

it.each(['missing', 'unreadable', 'malformed', 'partial append'])('rejects %s attempt journals at consumption (review 3)', async failure => {
  expect((await call('apply_to_disposable')).ok).toBe(true)
  const journal = join(root, 'proposals', `${proposalId}.sdk-attempts.jsonl`)
  if (failure === 'missing') await rm(journal, { force: true })
  // Keep the injection reachable on the implementation before attempt journals.
  if (failure === 'unreadable') await fs.appendFile(journal, '')
  const restore = failure === 'unreadable' ? await unreadableFile(journal) : undefined
  if (failure === 'malformed' || failure === 'partial append') await fs.appendFile(journal, failure === 'malformed' ? '{}\n' : '{')
  try { expect((await call('preview_migration')).ok).toBe(false) }
  finally { await restore?.() }
  expect(runSdkTarget).toHaveBeenCalledTimes(1)
})

it('rejects publication overtaken by another revalidation attempt (review 3)', async () => {
  const competitor = new Store(root); await competitor.init()
  vi.mocked(runSdkTarget).mockImplementationOnce(async options => {
    expect(await new Workflow(competitor).call('validate', { proposalId })).toMatchObject({ error: { code: 'instance_busy' } })
    return targetProof(options)
  })
  expect((await call('apply_to_disposable')).ok).toBe(false)
  expect((await record()).evidence).toBeUndefined()
  expect((await consumerProcess('preview_migration').result()).ok).toBe(false)
})

it('binds changed inputs even when attempt-start publication itself fails (review 3)', async () => {
  expect((await call('apply_to_disposable')).ok).toBe(true)
  const journal = join(root, 'proposals', `${proposalId}.sdk-attempts.jsonl`)
  // On the implementation before attempt journals this file is inert.
  await fs.appendFile(journal, '')
  const restore = await unreadableFile(journal)
  await expect(fs.open(journal, 'a')).rejects.toMatchObject({ code: 'EISDIR' })
  await writeFile(path(), json({ ...await record(), createdAt: '2026-01-01T00:00:00.000Z' }))
  try { expect((await call('validate')).ok).toBe(false) }
  finally { await restore() }
  expect((await call('preview_migration')).ok).toBe(false)
  expect(runSdkTarget).toHaveBeenCalledTimes(1)
})
