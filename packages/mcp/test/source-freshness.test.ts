import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { byteHash, byteManifest } from '../src/byte-digest.ts'
import { Store } from '../src/storage.ts'
import { copyHistoricalInstances } from './fixtures.ts'

let scratch: string, root: string, store: Store
beforeEach(async () => {
  scratch = await fs.mkdtemp(join(tmpdir(), 'source-freshness-'))
  await copyHistoricalInstances(scratch)
  root = join(scratch, 'examples/sample')
  await fs.writeFile(join(root, 'package.json'), '{"type":"module"}')
  store = new Store(root); await store.init(); root = store.root
})
afterEach(async () => { await fs.rm(scratch, { recursive: true, force: true }) })

it('builds a deterministic byte manifest with absent distinct from empty', () => {
  const empty = Buffer.alloc(0), replacement = Buffer.from('\ufffd'), invalid = Buffer.from([0x80])
  expect(byteManifest({ z: empty, a: replacement })).toEqual(byteManifest({ a: replacement, z: empty }))
  expect(JSON.stringify(byteManifest({ z: empty, a: replacement }))).toBe(JSON.stringify(byteManifest({ a: replacement, z: empty })))
  expect(byteManifest({})).not.toEqual(byteManifest({ a: empty }))
  expect(replacement.toString('utf8')).toBe(invalid.toString('utf8'))
  expect(byteManifest({ a: replacement })).not.toEqual(byteManifest({ a: invalid }))
})

it.each(['access.lock.md', 'migrations/0099_comment.sql'])('fingerprints exact %s bytes, including two invalid UTF-8 comment values', async path => {
  const source = (bytes: Buffer) => Buffer.concat([Buffer.from('-- authored '), bytes, Buffer.from('\n')])
  const snapshots = []
  for (const bytes of [Buffer.from('\ufffd'), Buffer.from([0x80]), Buffer.from([0x81])]) {
    await fs.writeFile(join(root, path), source(bytes))
    snapshots.push(await store.load('sample'))
  }
  expect(new Set(snapshots.map(bundle => bundle.fingerprint)).size).toBe(3)
  expect(new Set(snapshots.map(bundle => bundle.guards[path])).size).toBe(3)
  await expect(store.commit('sample', [], snapshots[1].guards)).rejects.toMatchObject({ code: 'concurrent_modification' })
  expect(await fs.readFile(join(root, path))).toEqual(source(Buffer.from([0x81])))
})

it.each(['config.v2.ts', 'access.ts', 'schema/extra.ts'])('guards byte-only authored comments in %s before any publication', async path => {
  await fs.mkdir(join(root, 'schema'), { recursive: true })
  const prefix = await fs.readFile(join(root, path)).catch(error => { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error })
  const source = (bytes: Buffer) => Buffer.concat([prefix, Buffer.from('\n// authored '), bytes, Buffer.from('\n')])
  await fs.writeFile(join(root, path), source(Buffer.from('\ufffd')))
  const bundle = await store.load('sample')
  expect(bundle.guards[path]).toBe(byteHash(await fs.readFile(join(root, path))))
  await expect(store.commit('sample', [], bundle.guards)).resolves.toBeUndefined()
  for (const [before, after] of [[Buffer.from('\ufffd'), Buffer.from([0x80])], [Buffer.from([0x80]), Buffer.from([0x81])]]) {
    // Exercise the raw publication boundary independently of the checked loader,
    // which correctly refuses to create a new proof for malformed TypeScript.
    const guards = { ...bundle.guards, [path]: byteHash(source(before)) }
    const external = source(after)
    await fs.writeFile(join(root, path), external)
    await expect(store.commit('sample', [{ path: 'proposals/abcd.json', data: '{}' }], guards)).rejects.toMatchObject({ code: 'concurrent_modification' })
    expect(await fs.readFile(join(root, path))).toEqual(external)
    await expect(store.load('sample')).rejects.toMatchObject({ name: 'SourceError', message: expect.stringContaining('Invalid UTF-8') })
    await expect(fs.readFile(join(root, 'proposals/abcd.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  }
})

it('distinguishes absent and empty tracked authored inputs in fingerprints and guards', async () => {
  const absent = await store.load('sample')
  await fs.writeFile(join(root, 'access.lock.md'), '')
  const empty = await store.load('sample')
  expect(empty.fingerprint).not.toBe(absent.fingerprint)
  await expect(store.commit('sample', [], absent.guards)).rejects.toMatchObject({ code: 'concurrent_modification' })
  await fs.rm(join(root, 'access.lock.md'))
  await expect(store.commit('sample', [], empty.guards)).rejects.toMatchObject({ code: 'concurrent_modification' })
})

it('fences a byte-only edit outside the write set at the publication boundary', async () => {
  const path = join(root, 'config.v2.ts')
  const original = Buffer.concat([await fs.readFile(path), Buffer.from('\n// authored \ufffd\n')])
  await fs.writeFile(path, original)
  const bundle = await store.load('sample'), position = original.indexOf(Buffer.from('\ufffd'))
  const external = Buffer.concat([original.subarray(0, position), Buffer.from([0x80]), original.subarray(position + 3)])
  const link = fs.link
  let injected = false
  const stub = vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
    await link(from, to)
    if (!injected && String(to) === join(root, 'proposals/.promotion.json')) { injected = true; await fs.writeFile(path, external) }
  })
  syncBuiltinESMExports()
  try {
    await expect(store.commit('sample', [{ path: 'proposals/abcd.json', data: '{}' }], bundle.guards)).rejects.toMatchObject({ code: 'concurrent_modification' })
  } finally { stub.mockRestore(); syncBuiltinESMExports() }
  expect(injected).toBe(true)
  expect(await fs.readFile(path)).toEqual(external)
  await expect(fs.readFile(join(root, 'proposals/abcd.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})
