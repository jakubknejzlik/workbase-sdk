import { registerTempDir, cleanupTempDir } from '../../../scripts/lib/test-temp-dir.mjs'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dependencySnapshot, Store } from '../src/storage.ts'
import { Workflow } from '../src/workflow.ts'
import { copyHistoricalInstances } from './fixtures.ts'

let fixture: string, root: string, id: string, store: Store, workflow: Workflow
const proposal = () => join(root, 'proposals', `${id}.json`)
beforeAll(async () => {
  fixture = registerTempDir(await fs.mkdtemp(join(tmpdir(), 'wb-dependencies-fixture-')))
  await copyHistoricalInstances(fixture)
  const dir = join(fixture, 'examples/sample')
  await fs.writeFile(join(dir, 'package.json'), '{"type":"module"}')
  await fs.writeFile(join(dir, 'bun.lock'), 'lock snapshot')
  const s = new Store(dir); await s.init()
  const w = new Workflow(s)
  const p = await w.call('propose_change', { instance: 'sample', baseRevision: 2, changes: [{ kind: 'add_field', entity: 'jobs', field: 'dependency_notes', definition: { type: 'text' } }] })
  id = String(p.proposalId)
  expect((await w.call('validate', { proposalId: id })).ok).toBe(true)
  expect((await w.call('apply_to_disposable', { proposalId: id })).verified).toBe(true)
})
afterAll(async () => { cleanupTempDir(fixture) })
beforeEach(async () => {
  root = registerTempDir(await fs.mkdtemp(join(tmpdir(), 'wb-dependencies-')))
  await fs.cp(join(fixture, 'examples/sample'), root, { recursive: true, verbatimSymlinks: true })
  store = new Store(root); await store.init(); workflow = new Workflow(store)
})
afterEach(async () => { cleanupTempDir(root) })
const promote = () => workflow.call('promote', { proposalId: id, expectedRevision: 2 })
it.each(['package.json', 'bun.lock'])('rejects promotion after only %s changes', async name => {
  await fs.appendFile(join(root, name), '\n')
  expect(await promote()).toMatchObject({ ok: false, error: { code: 'dependencies_changed', message: expect.stringContaining('znovu ověř') } })
})
it.each(['package.json', 'bun.lock'])('distinguishes absent and empty %s in freshness and publication guards', async name => {
  await fs.rm(join(root, name))
  const absent = await store.load('sample')
  await fs.writeFile(join(root, name), '')
  const empty = await store.load('sample')
  expect(empty.fingerprint).not.toBe(absent.fingerprint)
  await expect(store.commit('sample', [], absent.guards)).rejects.toMatchObject({ code: 'concurrent_modification' })
  await fs.rm(join(root, name))
  await expect(store.commit('sample', [], empty.guards)).rejects.toMatchObject({ code: 'concurrent_modification' })
  expect(await promote()).toMatchObject({ ok: false, error: { code: 'dependencies_changed' } })
})
it.each(['package.json', 'bun.lock'])('rejects symlinked %s', async name => {
  await fs.rm(join(root, name)); await fs.symlink(join(fixture, 'examples/sample', name), join(root, name))
  expect(await promote()).toMatchObject({ ok: false, error: { code: 'unsafe_path' } })
})
it.each(['package.json', 'bun.lock'])('rolls back publication when %s changes during publication', async name => {
  const before = await fs.readFile(proposal(), 'utf8'), config = await fs.readFile(join(root, 'config.ts'), 'utf8')
  const migrations = await fs.readdir(join(root, 'migrations'))
  const configFiles = (await fs.readdir(root)).filter(path => /^config.*\.(ts|json)$/.test(path)).sort()
  const configBytes = await Promise.all(configFiles.map(path => fs.readFile(join(root, path))))
  const migrationBytes = await Promise.all(migrations.map(path => fs.readFile(join(root, 'migrations', path))))
  const external = Buffer.concat([await fs.readFile(join(root, name)), Buffer.from('\nexternal')])
  const link = fs.link
  let injected = false
  const stub = vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
    await link(from, to)
    if (!injected && String(to).endsWith('/config.ts')) { injected = true; await fs.appendFile(join(root, name), '\nexternal') }
  })
  syncBuiltinESMExports()
  try {
    const result = await promote()
    expect(injected).toBe(true)
    expect(result).toMatchObject({ ok: false, error: { code: 'concurrent_modification', message: expect.stringContaining(name) } })
  }
  finally { stub.mockRestore(); syncBuiltinESMExports() }
  expect(injected).toBe(true)
  expect(await fs.readdir(join(root, 'migrations'))).toEqual(migrations)
  expect(await Promise.all(migrations.map(path => fs.readFile(join(root, 'migrations', path))))).toEqual(migrationBytes)
  expect((await fs.readdir(join(root, 'proposals'))).sort()).toEqual([`${id}.json`, 'log.jsonl'].sort())
  expect(await fs.readdir(root)).not.toContain('config.indexes.json')
  expect((await fs.readdir(root)).filter(path => /^config.*\.(ts|json)$/.test(path)).sort()).toEqual(configFiles)
  expect(await Promise.all(configFiles.map(path => fs.readFile(join(root, path))))).toEqual(configBytes)
  expect(await fs.readFile(proposal(), 'utf8')).toBe(before)
  expect(await fs.readFile(join(root, 'config.ts'), 'utf8')).toBe(config)
  expect(await fs.readFile(join(root, name))).toEqual(external)
})
it('captures only dependency hashes in proofs and promotion; unchanged dependencies promote', async () => {
  expect(await promote()).toMatchObject({ ok: true })
  const p = JSON.parse(await fs.readFile(proposal(), 'utf8'))
  expect(p.dependencyDigest).toMatch(/^[a-f0-9]{64}$/)
  expect(p.validation.dependencyDigest).toBe(p.dependencyDigest)
  expect(p.verification.dependencyDigest).toBe(p.dependencyDigest)
  expect(JSON.stringify(p)).not.toContain('lock snapshot')
})
it('requires validation again before disposable verification after a dependency edit', async () => {
  await fs.appendFile(join(root, 'bun.lock'), '\nchanged')
  expect(await workflow.call('apply_to_disposable', { proposalId: id })).toMatchObject({ ok: false, error: { code: 'validation_required' } })
  expect((await workflow.call('validate', { proposalId: id })).ok).toBe(true)
  expect((await workflow.call('apply_to_disposable', { proposalId: id })).verified).toBe(true)
  expect(await promote()).toMatchObject({ ok: true })
})
it('fingerprints raw dependency bytes even when UTF-8 decoding would be identical', async () => {
  await fs.writeFile(join(root, 'bun.lock'), Buffer.from([0x80]))
  const before = await store.load('sample')
  await fs.writeFile(join(root, 'bun.lock'), Buffer.from([0x81]))
  expect((await store.load('sample')).fingerprint).not.toBe(before.fingerprint)
  await expect(store.commit('sample', [], before.guards)).rejects.toMatchObject({ code: 'concurrent_modification' })
})

it('rejects an external symlink swapped in at the dependency read boundary', async () => {
  const path = join(root, 'bun.lock'), external = join(fixture, 'examples/sample/bun.lock')
  const readFile = fs.readFile, open = fs.open
  let injected = false
  const swap = async (target: unknown) => {
    if (!injected && String(target) === path) {
      injected = true
      await fs.rm(path)
      await fs.symlink(external, path)
    }
  }
  // Cover the old path-based read and the replacement atomic open at the same boundary.
  const readStub = vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
    await swap(args[0])
    return readFile(...args)
  })
  const openStub = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    await swap(args[0])
    return open(...args)
  })
  syncBuiltinESMExports()
  try {
    await expect(dependencySnapshot(root)).rejects.toMatchObject({ code: 'unsafe_path' })
    expect(injected).toBe(true)
  } finally { readStub.mockRestore(); openStub.mockRestore(); syncBuiltinESMExports() }
})
it.each(['package.json', 'bun.lock'])('rejects non-regular dependency %s', async name => {
  await fs.rm(join(root, name))
  await fs.mkdir(join(root, name))
  await expect(dependencySnapshot(root)).rejects.toMatchObject({ code: 'unsafe_path' })
})
