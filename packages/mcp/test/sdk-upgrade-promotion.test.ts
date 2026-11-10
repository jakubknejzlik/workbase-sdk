import { registerTempDir, cleanupTempDir } from '../../../scripts/lib/test-temp-dir.mjs'
import fs from 'node:fs/promises'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CORE_VERSION } from '@workbasehq/core/config'
import { Store, json } from '../src/storage.ts'
import { Workflow } from '../src/workflow.ts'
import { captureSdkInputs, runSdkTarget } from '../src/sdk-target.ts'
import { parseProposal } from '../src/proposals.ts'
import { digestBytes } from '../src/sdk-upgrade-protocol.ts'
import { instanceMeta } from '../src/offline.ts'
import { targetProof } from './fixtures/sdk-upgrade-evidence.ts'
import { copyHistoricalInstances } from './fixtures.ts'

vi.mock('../src/sdk-target.ts', async original => ({ ...await original<typeof import('../src/sdk-target.ts')>(), runSdkTarget: vi.fn() }))
const targetVersion = CORE_VERSION.replace(/\d+$/, patch => String(Number(patch) + 1))
const subsequentVersion = CORE_VERSION.replace(/\d+$/, patch => String(Number(patch) + 2))
let rawScratch: string, scratch: string, root: string, store: Store, workflow: Workflow, proposalId: string
const children: ChildProcess[] = []
const path = () => join(root, 'proposals', `${proposalId}.json`)
const record = async () => JSON.parse(await fs.readFile(path(), 'utf8'))
const promote = (expectedRevision = 2, signal?: AbortSignal) => workflow.call('promote', { proposalId, expectedRevision }, signal)
const restart = async () => { store = new Store(root); await store.init(); workflow = new Workflow(store) }
beforeEach(async () => {
  rawScratch = registerTempDir(await fs.mkdtemp(join(tmpdir(), 'wb-sdk-promotion-')))
  scratch = await fs.realpath(rawScratch)
  await fs.writeFile(join(scratch, 'package.json'), '{"type":"module"}')
  await copyHistoricalInstances(scratch)
  root = join(scratch, 'examples/sample')
  await fs.writeFile(join(root, 'package.json'), '{"type":"module","dependencies":{"@workbasehq/core":"0.2.1"}}\r\n')
  await fs.writeFile(join(root, 'bun.lock'), Buffer.from([0xff, 0, 0x80, 13, 10]))
  const sql = join(root, 'migrations/0001_initial.sql')
  await fs.writeFile(sql, (await fs.readFile(sql, 'utf8')).replaceAll(`'${CORE_VERSION}'`, "'0.2.1'"))
  await fs.writeFile(join(root, 'config.indexes.json'), '[]\r\n')
  await restart()
  vi.mocked(runSdkTarget).mockReset().mockImplementation(async options => {
    const proof = await targetProof(options)
    // Neither JSON nor lock bytes may be regenerated through text serialization.
    for (const [name, bytes] of Object.entries({
      'package.json': Buffer.from(`{ "type": "module", "dependencies": { "@workbasehq/core": "${targetVersion}" } }\r\n`),
      'bun.lock': Buffer.from([0xff, 0xfe, 0, 13, 10]),
    })) {
      proof.artifacts[name] = { bytes, sha256: digestBytes(bytes) }
      proof.result.inputHashes[name] = digestBytes(bytes)
    }
    proof.targetDependencyDigest = digestBytes(JSON.stringify(Object.fromEntries(['package.json', 'bun.lock'].map(name => [name, proof.artifacts[name].sha256]))))
    return proof
  })
  const proposed = await workflow.call('upgrade_sdk', { instance: 'sample', baseRevision: 2, targetVersion })
  expect(proposed.ok).toBe(true); proposalId = String(proposed.proposalId)
  expect(await workflow.call('apply_to_disposable', { proposalId })).toMatchObject({ ok: true, verified: true })
})
afterEach(async () => {
  vi.restoreAllMocks(); syncBuiltinESMExports()
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) {
    const closed = once(child, 'close'); child.kill('SIGKILL'); await closed
  }
  cleanupTempDir(rawScratch)
})

it('publishes exactly verified artifacts and transition, preserving revision and all application bytes', async () => {
  const before = await captureSdkInputs(root), accepted = await record()
  expect(await promote()).toMatchObject({ ok: true, status: 'promoted', revision: 2, appliesToDatabase: false })
  const after = await captureSdkInputs(root)
  for (const [name, file] of Object.entries(accepted.evidence.artifacts) as [string, { data: string }][]) {
    expect(after[name]).toEqual(Buffer.from(file.data, 'base64'))
  }
  for (const [name, bytes] of Object.entries(before)) if (!['package.json', 'bun.lock'].includes(name)) expect(after[name]).toEqual(bytes)
  expect(Object.keys(after).length).toBe(Object.keys(before).length + 1)
  const promoted = await record()
  expect(promoted.baseDependencyDigest).toBe(accepted.baseDependencyDigest)
  expect(promoted.evidence).toEqual(accepted.evidence)
  expect(promoted.promotion.inputHashes).toEqual(Object.fromEntries(Object.entries(after).map(([name, bytes]) => [name, digestBytes(bytes)])))
  expect(parseProposal(promoted)).toEqual(promoted)
  expect((await store.load('sample')).config.revision).toBe(2)
  expect(runSdkTarget).toHaveBeenCalledOnce()
})
it('restarts with a usable promotion snapshot even when the verified target is newer than the producer', async () => {
  expect(await promote()).toMatchObject({ ok: true })
  const snapshot = await fs.readFile(path()), inputs = await captureSdkInputs(root)
  await restart()
  expect((await store.find(proposalId)).proposal).toEqual(parseProposal(await record()))
  expect(await promote()).toMatchObject({ ok: true, status: 'promoted', revision: 2 })
  expect(await fs.readFile(path())).toEqual(snapshot)
  expect(await captureSdkInputs(root)).toEqual(inputs)
  expect(await workflow.call('upgrade_sdk', { instance: 'sample', baseRevision: 2, targetVersion: subsequentVersion })).toMatchObject({ ok: true })
})
it.each(['validate', 'preview_migration', 'apply_to_disposable', 'discard'])('preserves promoted authorization after rejecting closed %s and restarting', async action => {
  expect(await promote()).toMatchObject({ ok: true })
  const snapshot = await fs.readFile(path()), inputs = await captureSdkInputs(root)
  const attempts = join(root, 'proposals', `${proposalId}.sdk-attempts.jsonl`), intent = await fs.readFile(attempts)
  expect(await workflow.call(action, { proposalId })).toMatchObject({ error: { code: 'proposal_closed', status: 409 } })
  await restart()
  expect(await promote()).toMatchObject({ ok: true, status: 'promoted', revision: 2 })
  expect(await fs.readFile(path())).toEqual(snapshot)
  expect(await fs.readFile(attempts)).toEqual(intent)
  expect(await captureSdkInputs(root)).toEqual(inputs)
})
it.each(['package.json', 'bun.lock', 'marker', 'revoked'])('rejects %s drift when consuming a promoted snapshot', async name => {
  expect(await promote()).toMatchObject({ ok: true })
  if (name === 'revoked') await fs.link(path(), `${path()}.sdk-revoked`)
  else await fs.appendFile(join(root, name === 'marker' ? (await record()).evidence.result.stage.marker.path : name), '\n ')
  const before = await captureSdkInputs(root), source = await fs.readFile(path())
  await restart()
  expect(await promote()).toMatchObject({ error: { code: 'validation_required', status: 409 } })
  expect(await captureSdkInputs(root)).toEqual(before); expect(await fs.readFile(path())).toEqual(source)
})
it.each(['validated', 'missing', 'revoked', 'stale attempt', 'tampered record'])('rejects %s evidence without touching Instance or proposal bytes', async mode => {
  if (mode === 'validated') expect((await workflow.call('validate', { proposalId })).ok).toBe(true)
  if (mode === 'missing') { const p = await record(); p.status = 'proposed'; delete p.evidence; await fs.writeFile(path(), json(p)) }
  if (mode === 'revoked') await fs.link(path(), `${path()}.sdk-revoked`)
  if (mode === 'stale attempt') await store.startSdkAttempt(proposalId)
  if (mode === 'tampered record') { const p = await record(); p.createdAt = '2026-01-01T00:00:00.000Z'; await fs.writeFile(path(), json(p)) }
  const before = await captureSdkInputs(root), source = await fs.readFile(path())
  expect(await promote()).toMatchObject({ ok: false, error: { code: mode === 'validated' ? 'verification_required' : 'validation_required', status: 409 } })
  expect(await captureSdkInputs(root)).toEqual(before); expect(await fs.readFile(path())).toEqual(source)
})
it.each(['package.json', 'bun.lock', 'config.ts', 'config.v2.ts', 'config.versions.json', 'config.indexes.json', 'migrations/0001_initial.sql', 'marker collision'])('rejects %s drift without publishing or rewriting evidence', async name => {
  if (name === 'marker collision') await fs.writeFile(join(root, (await record()).evidence.result.stage.marker.path), '-- external collision\n')
  else await fs.appendFile(join(root, name), '\n ')
  const before = await captureSdkInputs(root), source = await fs.readFile(path())
  expect(await promote()).toMatchObject({ ok: false, error: { code: 'validation_required', status: 409 } })
  expect(await captureSdkInputs(root)).toEqual(before); expect(await fs.readFile(path())).toEqual(source)
  await restart(); expect(await captureSdkInputs(root)).toEqual(before)
})
it('rejects an incorrect expected revision without publication', async () => {
  const before = await captureSdkInputs(root), source = await fs.readFile(path())
  expect(await promote(3)).toMatchObject({ error: { code: 'stale_revision', status: 409 } })
  expect(await captureSdkInputs(root)).toEqual(before); expect(await fs.readFile(path())).toEqual(source)
})
it.each(['bun.lock', 'marker', 'proposal', 'post-publication check'])('restores exact original bytes after failure at %s', async destination => {
  const before = await captureSdkInputs(root), source = await fs.readFile(path()), accepted = await record()
  const failAt = destination === 'marker' ? join(root, accepted.evidence.result.stage.marker.path) : destination === 'proposal' ? path() : join(root, 'bun.lock')
  const original = fs.link
  let injected = false
  vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
    if (!injected && String(to) === failAt) {
      injected = true
      expect(await fs.readFile(join(root, 'package.json'))).toEqual(Buffer.from(accepted.evidence.artifacts['package.json'].data, 'base64'))
      throw Object.assign(new Error('root-independent injected failure'), { code: 'EIO' })
    }
    return original(from, to)
  })
  if (destination === 'post-publication check') {
    vi.mocked(fs.link).mockRestore()
    const load = store.load.bind(store)
    vi.spyOn(store, 'load').mockImplementation(async instance => {
      const bundle = await load(instance)
      if ((await record()).status === 'promoted') { injected = true; throw new Error('injected post-publication failure') }
      return bundle
    })
  }
  syncBuiltinESMExports()
  expect(await promote()).toMatchObject({ ok: false })
  expect(injected).toBe(true)
  expect(await captureSdkInputs(root)).toEqual(before); expect(await fs.readFile(path())).toEqual(source)
  vi.restoreAllMocks(); syncBuiltinESMExports()
  await restart()
  expect(await captureSdkInputs(root)).toEqual(before); expect(await fs.readFile(path())).toEqual(source)
  expect(await promote()).toMatchObject({ ok: true })
})
it.each(['bun.lock', 'proposal'].flatMap(destination => [false, true].map(restartRequired => ({ destination, restartRequired }))))('restores captured originals after unlink EIO (%j)', async ({ destination, restartRequired }) => {
  const before = await captureSdkInputs(root), source = await fs.readFile(path())
  const target = destination === 'proposal' ? path() : join(root, destination), originalInode = await fs.lstat(target)
  const unlink = fs.unlink, open = fs.open
  let captured = '', injected = false, rollbackFailed = false
  observeCapture(target, async temporary => { if (!captured) captured = temporary })
  vi.spyOn(fs, 'unlink').mockImplementation(async file => {
    if (!injected && captured && String(file) === target) {
      injected = true
      await unlink(file)
      throw Object.assign(new Error('captured-original unlink failure'), { code: 'EIO' })
    }
    return unlink(file)
  })
  // Leave recovery entirely to a fresh Store, without its in-memory progress.
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (restartRequired && injected && String(args[0]) === captured) {
      rollbackFailed = true
      throw Object.assign(new Error('rollback capture read failure'), { code: 'EIO' })
    }
    return open(...args)
  })
  syncBuiltinESMExports()
  expect(await promote()).toMatchObject({ ok: false })
  expect(injected).toBe(true)
  expect(rollbackFailed).toBe(restartRequired)
  vi.restoreAllMocks(); syncBuiltinESMExports()
  if (restartRequired) {
    await expect(fs.readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(captured)).toEqual(destination === 'proposal' ? source : before[destination])
  } else {
    expect(await captureSdkInputs(root)).toEqual(before); expect(await fs.readFile(path())).toEqual(source)
  }
  await restart()
  expect(await captureSdkInputs(root)).toEqual(before); expect(await fs.readFile(path())).toEqual(source)
  expect(await fs.lstat(target)).toMatchObject({ dev: originalInode.dev, ino: originalInode.ino })
  await expect(fs.readFile(captured)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(fs.readFile(join(root, 'proposals/.promotion.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await promote()).toMatchObject({ ok: true })
})
it('review-3: rolls back from memory when the on-disk journal cannot be re-read', async () => {
  const before = await captureSdkInputs(root), source = await fs.readFile(path())
  const load = store.load.bind(store), readFile = fs.readFile
  let rollingBack = false, journalReads = 0
  vi.spyOn(store, 'load').mockImplementation(async instance => {
    const bundle = await load(instance)
    if ((await record()).status === 'promoted') {
      rollingBack = true
      throw Object.assign(new Error('post-publication verification EIO'), { code: 'EIO' })
    }
    return bundle
  })
  vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
    if (rollingBack && String(args[0]) === join(root, 'proposals/.promotion.json')) {
      journalReads++
      throw Object.assign(new Error('journal re-read EIO'), { code: 'EIO' })
    }
    return readFile(...args)
  })
  syncBuiltinESMExports()
  expect(await promote()).toMatchObject({ ok: false })
  expect(rollingBack).toBe(true)
  expect(await captureSdkInputs(root)).toEqual(before)
  expect(await fs.readFile(path())).toEqual(source)
  expect(journalReads).toBe(0)
  vi.restoreAllMocks(); syncBuiltinESMExports()
  await restart()
  expect(await captureSdkInputs(root)).toEqual(before)
  expect(await fs.readFile(path())).toEqual(source)
  await expect(fs.readFile(join(root, 'proposals/.promotion.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it.each(['EIO', 'EAGAIN', 'EBUSY', 'ENOSPC'])('review-3: completes owned rollback after a single retained-file %s', async code => {
  const before = await captureSdkInputs(root), source = await fs.readFile(path())
  const load = store.load.bind(store), open = fs.open
  let saved = '', injected = false
  vi.spyOn(store, 'load').mockImplementation(async instance => {
    const bundle = await load(instance)
    if ((await record()).status === 'promoted') {
      const journal = JSON.parse(await fs.readFile(join(root, 'proposals/.promotion.json'), 'utf8'))
      saved = join(root, `package.json.${journal.files.find((file: { path: string }) => file.path === 'package.json').capture.token}.tmp`)
      throw Object.assign(new Error('post-publication verification EIO'), { code: 'EIO' })
    }
    return bundle
  })
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (saved && String(args[0]) === saved && !injected) {
      injected = true
      throw Object.assign(new Error('single rollback read fault'), { code })
    }
    return open(...args)
  })
  syncBuiltinESMExports()
  expect(await promote()).toMatchObject({ ok: false })
  expect(injected).toBe(true)
  expect(await captureSdkInputs(root)).toEqual(before)
  expect(await fs.readFile(path())).toEqual(source)
  vi.restoreAllMocks(); syncBuiltinESMExports()
  for (let attempt = 0; attempt < 2; attempt++) {
    await restart()
    expect(await captureSdkInputs(root)).toEqual(before)
    expect(await fs.readFile(path())).toEqual(source)
    expect((await fs.readdir(join(root, 'proposals'))).filter(name => name.includes('.conflict-'))).toEqual([])
  }
})
it('review-3: leaves persistent rollback and recovery I/O faults retryable across restarts', async () => {
  const before = await captureSdkInputs(root), source = await fs.readFile(path())
  const load = store.load.bind(store), open = fs.open
  let saved = '', fault = true, injected = 0
  vi.spyOn(store, 'load').mockImplementation(async instance => {
    const bundle = await load(instance)
    if ((await record()).status === 'promoted') {
      const journal = JSON.parse(await fs.readFile(join(root, 'proposals/.promotion.json'), 'utf8'))
      saved = join(root, `package.json.${journal.files.find((file: { path: string }) => file.path === 'package.json').capture.token}.tmp`)
      throw Object.assign(new Error('post-publication verification EIO'), { code: 'EIO' })
    }
    return bundle
  })
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (fault && saved && String(args[0]) === saved) {
      injected++
      throw Object.assign(new Error('retained-file read EIO'), { code: 'EIO' })
    }
    return open(...args)
  })
  syncBuiltinESMExports()
  expect(await promote()).toMatchObject({ ok: false })
  expect(injected).toBeGreaterThan(0)
  const noConflict = async () => expect((await fs.readdir(join(root, 'proposals'))).filter(name => name.includes('.conflict-'))).toEqual([])
  await noConflict()
  await expect(restart()).rejects.toMatchObject({ code: 'EIO' })
  await noConflict()
  fault = false
  for (let attempt = 0; attempt < 2; attempt++) {
    await restart()
    expect(await captureSdkInputs(root)).toEqual(before)
    expect(await fs.readFile(path())).toEqual(source)
    await noConflict()
  }
  await expect(fs.readFile(join(root, 'proposals/.promotion.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it('review-3: recovers decimal-string bigint identities after publication and rollback EIO', async () => {
  const before = await captureSdkInputs(root), source = await fs.readFile(path())
  const open = fs.open, link = fs.link
  const high = 1n << 60n
  let saved = '', injected = false, rollbackFault = true
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (rollbackFault && saved && String(args[0]) === saved) throw Object.assign(new Error('rollback read EIO'), { code: 'EIO' })
    const handle = await open(...args), stat = handle.stat.bind(handle)
    handle.stat = (async (options?: { bigint?: boolean }) => {
      const info = options?.bigint ? await stat({ bigint: true }) : await stat()
      // Simulate high device/inode bits without losing precision in bigint mode.
      return Object.assign(info, Object.fromEntries(['dev', 'ino'].map(key => {
        const value = high + 2n * BigInt(info[key as 'dev' | 'ino']) + 1n
        return [key, options?.bigint ? value : Number(value)]
      })))
    }) as typeof handle.stat
    return handle
  })
  vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
    if (!injected && String(to) === join(root, 'bun.lock')) {
      injected = true
      const journal = JSON.parse(await fs.readFile(join(root, 'proposals/.promotion.json'), 'utf8'))
      saved = join(root, `package.json.${journal.files.find((file: { path: string }) => file.path === 'package.json').capture.token}.tmp`)
      throw Object.assign(new Error('pre-link publication EIO'), { code: 'EIO' })
    }
    return link(from, to)
  })
  syncBuiltinESMExports()
  expect(await promote()).toMatchObject({ ok: false })
  expect(injected).toBe(true)
  const journal = JSON.parse(await fs.readFile(join(root, 'proposals/.promotion.json'), 'utf8'))
  for (const file of journal.files) for (const identity of [file.after, ...(file.capture ? [file.capture.identity] : [])]) {
    for (const key of ['dev', 'ino']) {
      expect(typeof identity[key]).toBe('string')
      expect(BigInt(identity[key])).toBeGreaterThan(high)
      expect(BigInt(identity[key]) % 2n).toBe(1n)
    }
  }
  rollbackFault = false
  await restart()
  expect(await captureSdkInputs(root)).toEqual(before)
  expect(await fs.readFile(path())).toEqual(source)
  await restart()
  expect((await fs.readdir(join(root, 'proposals'))).filter(name => name.includes('.conflict-'))).toEqual([])
  await expect(fs.readFile(join(root, 'proposals/.promotion.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it('keeps submit_change rejected after SDK promotion', async () => {
  expect(await promote()).toMatchObject({ ok: true })
  const before = await captureSdkInputs(root), source = await fs.readFile(path())
  expect(await workflow.call('submit_change', { proposalId, instance: 'sample', expectedBaseSha: 'a'.repeat(40) })).toMatchObject({ error: { code: 'sdk_upgrade_not_supported', status: 409 } })
  expect(await captureSdkInputs(root)).toEqual(before); expect(await fs.readFile(path())).toEqual(source)
})

// Exercise the capture boundary on both the reviewed rename implementation and
// the exclusive-link implementation. These are behavioral regression tests.
function observeCapture(target: string, inspect: (saved: string) => Promise<void>, beforeLink?: (from: string, to: string) => Promise<void>) {
  const rename = fs.rename, link = fs.link
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(from) === target) await inspect(String(to))
    return rename(from, to)
  })
  vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
    if (String(from) === target) await inspect(String(to))
    await beforeLink?.(String(from), String(to))
    return link(from, to)
  })
}
it.each(['bun.lock', 'proposal'])('review-2: rolls back every owned publication after a foreign %s capture and transient read fault', async destination => {
  const before = await captureSdkInputs(root), source = await fs.readFile(path())
  const target = destination === 'proposal' ? path() : join(root, destination)
  const foreign = Buffer.from('concurrent user bytes\n'), open = fs.open
  let saved = '', injected = false
  observeCapture(target, async temporary => {
    if (!saved) { saved = temporary; await fs.writeFile(target, foreign) }
  })
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (saved && String(args[0]) === saved && !injected) {
      injected = true
      throw Object.assign(new Error('single capture-read EIO'), { code: 'EIO' })
    }
    return open(...args)
  })
  syncBuiltinESMExports()
  expect(await promote()).toMatchObject({ ok: false })
  expect(injected).toBe(true)
  vi.restoreAllMocks(); syncBuiltinESMExports()
  expect(await fs.readFile(target)).toEqual(foreign)
  const expected = { ...before }
  if (destination === 'bun.lock') expected['bun.lock'] = foreign
  expect(await captureSdkInputs(root)).toEqual(expected)
  expect(await fs.readFile(path())).toEqual(destination === 'proposal' ? foreign : source)
  expect(await fs.readFile(saved)).toEqual(foreign)
  const journal = await fs.readFile(join(root, 'proposals/.promotion.json'))
  await expect(restart()).rejects.toMatchObject({ code: 'concurrent_modification' })
  expect(await fs.readFile(join(root, 'proposals/.promotion.json'))).toEqual(journal)
  expect(await fs.readFile(saved)).toEqual(foreign)
  expect(await captureSdkInputs(root)).toEqual(expected)
})
it.each(['bun.lock', 'proposal'].flatMap(destination => [false, true].map(identical => ({ destination, identical }))))('review-2: retains recovery state on capture substitution (%j)', async ({ destination, identical }) => {
  const before = await captureSdkInputs(root), source = await fs.readFile(path())
  const target = destination === 'proposal' ? path() : join(root, destination)
  const original = destination === 'proposal' ? source : before[destination]
  const foreign = identical ? original : Buffer.from('substituted capture bytes\n')
  const unlink = fs.unlink, rename = fs.rename
  let saved = '', injected = false, substituted = false
  observeCapture(target, async temporary => { if (!saved) saved = temporary }, async (from, to) => {
    if (injected && from === saved && to === target && !substituted) {
      substituted = true
      await rename(saved, `${saved}.actual-original`)
      await fs.writeFile(saved, foreign, { flag: 'wx' })
    }
  })
  vi.spyOn(fs, 'unlink').mockImplementation(async file => {
    if (saved && !injected && [saved, target].includes(String(file))) {
      injected = true
      // The new capture retains its original; fail after removing the canonical
      // link. The reviewed implementation fails while removing the capture.
      if (String(file) === target) await unlink(file)
      throw Object.assign(new Error('single capture-unlink EIO'), { code: 'EIO' })
    }
    return unlink(file)
  })
  syncBuiltinESMExports()
  expect(await promote()).toMatchObject({ ok: false, error: { code: 'concurrent_modification' } })
  expect(injected).toBe(true); expect(substituted).toBe(true)
  vi.restoreAllMocks(); syncBuiltinESMExports()
  expect(await fs.readFile(saved)).toEqual(foreign)
  expect(await fs.readFile(`${saved}.actual-original`)).toEqual(original)
  // Other publications, including the SQL marker and proposal transition, must
  // all roll back even if this canonical path now contains foreign bytes.
  const expected = { ...before }
  if (destination === 'bun.lock') expected['bun.lock'] = await fs.readFile(target)
  expect(await captureSdkInputs(root)).toEqual(expected)
  if (destination !== 'proposal') expect(await fs.readFile(path())).toEqual(source)
  const journal = await fs.readFile(join(root, 'proposals/.promotion.json'))
  await expect(restart()).rejects.toMatchObject({ code: 'concurrent_modification' })
  expect(await fs.readFile(join(root, 'proposals/.promotion.json'))).toEqual(journal)
  expect(await fs.readFile(saved)).toEqual(foreign)
})
it.each(['bun.lock', 'proposal'])('review-2: reserves %s capture storage without replacing an occupant', async destination => {
  const before = await captureSdkInputs(root), source = await fs.readFile(path())
  const target = destination === 'proposal' ? path() : join(root, destination)
  const foreign = Buffer.from('pre-existing foreign capture\n')
  let saved = ''
  observeCapture(target, async temporary => {
    if (!saved) { saved = temporary; await fs.writeFile(saved, foreign, { flag: 'wx' }) }
  })
  syncBuiltinESMExports()
  const result = await promote()
  vi.restoreAllMocks(); syncBuiltinESMExports()
  expect(saved).not.toBe('')
  expect(await fs.readFile(saved)).toEqual(foreign)
  expect(result).toMatchObject({ ok: false, error: { code: 'concurrent_modification' } })
  expect(await captureSdkInputs(root)).toEqual(before); expect(await fs.readFile(path())).toEqual(source)
  const journal = await fs.readFile(join(root, 'proposals/.promotion.json'))
  await expect(restart()).rejects.toMatchObject({ code: 'concurrent_modification' })
  expect(await fs.readFile(saved)).toEqual(foreign)
  expect(await fs.readFile(join(root, 'proposals/.promotion.json'))).toEqual(journal)
})
it.each(['bun.lock', 'proposal'])('recovers an actual process death at %s publication and can retry', async destination => {
  const before = await captureSdkInputs(root), source = await fs.readFile(path()), accepted = await record()
  const script = join(scratch, 'promote.mts')
  await fs.writeFile(script, `
    import fs from 'node:fs/promises'
    import { syncBuiltinESMExports } from 'node:module'
    import { Store } from ${JSON.stringify(resolve('packages/mcp/src/storage.ts'))}
    import { Workflow } from ${JSON.stringify(resolve('packages/mcp/src/workflow.ts'))}
    const store = new Store(${JSON.stringify(root)}); await store.init()
    const link = fs.link
    fs.link = async (from, to) => {
      const stop = String(to) === ${JSON.stringify(destination === 'proposal' ? path() : join(root, 'bun.lock'))}
      if (stop && ${destination === 'proposal'}) await link(from, to)
      if (stop) { process.send({ event: 'publication' }); await new Promise(() => {}) }
      return link(from, to)
    }
    syncBuiltinESMExports()
    process.send({ event: 'result', result: await new Workflow(store).call('promote', ${JSON.stringify({ proposalId, expectedRevision: 2 })}) })
  `)
  const child = spawn(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), script], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: process.env })
  children.push(child)
  let diagnostics = ''; child.stderr!.on('data', bytes => { diagnostics += bytes })
  const closed = once(child, 'close')
  const event = await Promise.race([once(child, 'message').then(([message]) => message), closed.then(() => ({ event: 'closed', diagnostics }))])
  expect(event).toEqual({ event: 'publication' })
  expect(await fs.readFile(join(root, 'package.json'))).toEqual(Buffer.from(accepted.evidence.artifacts['package.json'].data, 'base64'))
  child.kill('SIGKILL'); await closed
  await restart()
  expect(await captureSdkInputs(root)).toEqual(before); expect(await fs.readFile(path())).toEqual(source)
  await expect(fs.readFile(join(root, 'proposals/.promotion.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await promote()).toMatchObject({ ok: true })
})
it.each(['before publication', 'during publication'])('restores original bytes when cancelled %s', async phase => {
  const before = await captureSdkInputs(root), source = await fs.readFile(path()), controller = new AbortController()
  if (phase === 'before publication') controller.abort()
  else {
    const link = fs.link
    vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
      await link(from, to)
      if (String(to) === join(root, 'package.json')) controller.abort()
    })
    syncBuiltinESMExports()
  }
  expect(await promote(2, controller.signal)).toMatchObject({ error: { code: 'sdk_upgrade_cancelled', status: 409 } })
  expect(await captureSdkInputs(root)).toEqual(before); expect(await fs.readFile(path())).toEqual(source)
})
it('still rejects an unauthorised future SDK stamp outside SDK target verification', async () => {
  const bundle = await store.load('sample')
  bundle.migrations.push({ name: '0002_foreign.sql', sql: `UPDATE instance_meta SET core_version = '${targetVersion}';` })
  expect(() => instanceMeta(bundle)).toThrow(expect.objectContaining({ code: 'revision_mismatch' }))
})
