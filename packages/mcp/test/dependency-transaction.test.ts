import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dependencySnapshot, Store } from '../src/storage.ts'
import { hash } from '../src/planning.ts'
import { copyHistoricalInstances } from './fixtures.ts'

let scratch: string, root: string, store: Store, guards: Record<string, string | null>
const files = [
  { path: 'package.json', data: '{"type":"module","version":"2"}' },
  { path: 'bun.lock', data: 'new lock\n' },
  { path: 'migrations/0099_upgrade.sql', data: '-- upgrade', create: true },
  { path: 'config.versions.json', data: '{"revision":3}' },
  { path: 'proposals/abcd.json', data: '{"status":"promoted"}' },
]
const journalPath = () => join(root, 'proposals/.promotion.json')
const rawHash = (data: Buffer | string) => hash(Buffer.from(data).toString('base64'))
const entry = (path = 'bun.lock', before: string | null = Buffer.from([0x80, 0, 0xff]).toString('base64')) => ({ path, before, afterHash: rawHash('published') })
const saveJournal = async (journal: unknown) => fs.writeFile(journalPath(), JSON.stringify(journal))
const bytes = async (path: string) => fs.readFile(join(root, path)).catch(error => { if (error.code === 'ENOENT') return null; throw error })
const snapshot = () => Promise.all(files.map(f => bytes(f.path)))
const commit = async () => store.commit('sample', files, { ...guards, ...(await dependencySnapshot(root)).guards })
async function interceptRename(fn: (destination: string) => Promise<void>, run: () => Promise<void>) {
  // Test-only syscall seam: publication used rename historically, now installs with link.
  const rename = fs.rename, link = fs.link
  const stub = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => { await rename(from, to); await fn(String(to)) })
  const linked = vi.spyOn(fs, 'link').mockImplementation(async (from, to) => { await link(from, to); await fn(String(to)) })
  syncBuiltinESMExports()
  try { await run() } finally { stub.mockRestore(); linked.mockRestore(); syncBuiltinESMExports() }
}
beforeEach(async () => {
  scratch = await fs.mkdtemp(join(tmpdir(), 'wb-dependency-tx-'))
  await copyHistoricalInstances(scratch)
  root = join(scratch, 'examples/sample')
  await fs.writeFile(join(root, 'package.json'), '{"type":"module"}')
  await fs.writeFile(join(root, 'bun.lock'), Buffer.from([0x80, 0, 0xff]))
  store = new Store(root); await store.init(); root = store.root
  guards = (await store.load('sample')).guards
})
afterEach(async () => { await fs.rm(scratch, { recursive: true, force: true }) })

it('publishes manifest + lock + migration + history + proposal as one guarded snapshot', async () => {
  await expect(commit()).resolves.toBeUndefined()
  expect(await snapshot()).toEqual(files.map(f => Buffer.from(f.data)))
  expect(await bytes('proposals/.promotion.json')).toBeNull()
  await expect(commit()).rejects.toMatchObject({ code: 'migration_exists' })
  await expect(store.commit('sample', files.filter(f => !f.create), { ...guards, ...Object.fromEntries(files.map(f => [f.path, ['package.json', 'bun.lock'].includes(f.path) ? rawHash(f.data) : hash(f.data)])) })).resolves.toBeUndefined()
})
for (const absent of [false, true]) {
  it.each(['proposals/.promotion.json', ...files.map(f => f.path)])(`restores exact bytes after %s publication (dependencies absent=${absent})`, async boundary => {
    if (absent) for (const path of ['package.json', 'bun.lock']) await fs.rm(join(root, path))
    const before = await snapshot()
    let injected = false
    await interceptRename(async destination => {
      if (!injected && destination === join(root, boundary)) { injected = true; throw new Error('publication fault') }
    }, async () => { await expect(commit()).rejects.toThrow('publication fault') })
    expect(injected).toBe(true)
    expect(await snapshot()).toEqual(before)
    expect(await bytes('proposals/.promotion.json')).toBeNull()
  })
}
it.each(files.map(f => f.path))('preserves concurrent external bytes in %s and reports failure', async path => {
  const before = await snapshot()
  let injected = false
  await interceptRename(async destination => {
    if (!injected && destination === join(root, path)) { injected = true; await fs.writeFile(destination, Buffer.from([0x81, 0xfe])) }
  }, async () => { await expect(commit()).rejects.toMatchObject({ code: 'concurrent_modification' }) })
  expect(injected).toBe(true)
  expect(await snapshot()).toEqual(before.map((value, i) => files[i].path === path ? Buffer.from([0x81, 0xfe]) : value))
  expect(await bytes('proposals/.promotion.json')).not.toBeNull()
})
it.each(['migrations/0099_upgrade.sql', 'bun.lock'])('preserves unpublished external %s matching the planned afterHash', async target => {
  const before = await snapshot()
  const external = Buffer.from(files.find(file => file.path === target)!.data)
  let injected = false
  await interceptRename(async destination => {
    if (!injected && destination === journalPath()) {
      injected = true
      await fs.writeFile(join(root, target), external)
    }
  }, async () => { await expect(commit()).rejects.toMatchObject({ code: 'concurrent_modification' }) })
  expect(injected).toBe(true)
  expect(await bytes(target)).toEqual(external)
  expect(await snapshot()).toEqual(before.map((value, i) => files[i].path === target ? external : value))
  expect(await bytes('proposals/.promotion.json')).not.toBeNull()
  // A retained conflict marker must also prevent a recovery retry from claiming it.
  await expect(store.recover(root)).rejects.toMatchObject({ code: 'concurrent_modification' })
  expect(await bytes(target)).toEqual(external)
})
it('rejects external bytes even when their UTF-8 decoding equals the published proposal', async () => {
  const before = await snapshot(), target = 'proposals/abcd.json'
  const changed = files.map(f => f.path === target ? { ...f, data: '\ufffd' } : f)
  let injected = false
  await interceptRename(async destination => {
    if (!injected && destination === join(root, target)) { injected = true; await fs.writeFile(destination, Buffer.from([0x80])) }
  }, async () => {
    await expect(store.commit('sample', changed, guards)).rejects.toMatchObject({ code: 'concurrent_modification' })
  })
  expect(injected).toBe(true)
  expect(await snapshot()).toEqual(before.map((value, i) => files[i].path === target ? Buffer.from([0x80]) : value))
  expect(await bytes('proposals/.promotion.json')).not.toBeNull()
})
it('recovers dependency journal exact bytes and absence, repeatedly', async () => {
  await fs.writeFile(join(root, 'bun.lock'), 'published')
  await fs.writeFile(join(root, 'package.json'), 'published')
  await saveJournal({ version: 2, files: [entry(), entry('package.json', null)] })
  await store.recover(root); await store.recover(root)
  expect(await bytes('bun.lock')).toEqual(Buffer.from([0x80, 0, 0xff]))
  expect(await bytes('package.json')).toBeNull()
  expect(await bytes('proposals/.promotion.json')).toBeNull()
})
it('retries interrupted recovery without overwriting an external edit or restored bytes', async () => {
  await fs.writeFile(join(root, 'bun.lock'), 'published')
  await fs.writeFile(join(root, 'package.json'), 'published')
  await saveJournal({ version: 2, files: [entry(), entry('package.json', null)] })
  await interceptRename(async destination => {
    if (destination === join(root, 'bun.lock')) throw new Error('rollback interrupted')
  }, async () => { await expect(store.recover(root)).rejects.toThrow('rollback interrupted') })
  expect(await bytes('bun.lock')).toEqual(Buffer.from([0x80, 0, 0xff]))
  await fs.writeFile(join(root, 'package.json'), 'external')
  await expect(store.recover(root)).rejects.toMatchObject({ code: 'concurrent_modification' })
  await expect(store.recover(root)).rejects.toMatchObject({ code: 'concurrent_modification' })
  expect(await bytes('proposals/.promotion.json')).not.toBeNull()
  expect(await bytes('bun.lock')).toEqual(Buffer.from([0x80, 0, 0xff]))
  expect(await bytes('package.json')).toEqual(Buffer.from('external'))
})
it('recovers legacy UTF-8 journals unchanged, including ownership hashes', async () => {
  await fs.writeFile(join(root, 'config.versions.json'), 'published')
  await saveJournal({ files: [
    { path: 'config.versions.json', before: 'original ž', afterHash: hash('published') },
    { path: 'proposals/abcd.json', before: 'legacy' },
    { path: 'migrations/0099_upgrade.sql', before: null },
  ] })
  await store.recover(root)
  expect(await bytes('config.versions.json')).toEqual(Buffer.from('original ž'))
  expect(await bytes('proposals/abcd.json')).toEqual(Buffer.from('legacy'))
})
const invalid = [
  null, {}, { files: 'bad' }, { version: 3, files: [] },
  { version: 2, files: [entry(), entry()] },
  ...['../outside', '/tmp/outside', 'migrations/../bun.lock', 'proposals/.promotion.json', 'config.ts/child'].map(path => ({ version: 2, files: [entry(), entry(path)] })),
  { version: 2, files: [entry(), { ...entry('package.json'), before: 'not base64!' }] },
  { version: 2, files: [entry(), { path: 'package.json', before: null }] },
  { files: [{ path: 'config.ts', before: 'original' }, { path: '../outside', before: null }] },
]
it.each(invalid.map((journal, i) => [i, journal] as const))('validates entire malformed/duplicate/unsafe journal %s before restoring', async (_i, journal) => {
  await fs.writeFile(join(root, 'bun.lock'), 'published')
  const before = await fs.readFile(join(root, 'config.ts'))
  await saveJournal(journal)
  await expect(store.recover(root)).rejects.toMatchObject({ code: 'invalid_journal' })
  expect(await bytes('bun.lock')).toEqual(Buffer.from('published'))
  expect(await bytes('config.ts')).toEqual(before)
  expect(await bytes('proposals/.promotion.json')).not.toBeNull()
})
it.each(['file', 'parent'])('validates symlink %s before restoring any entry', async kind => {
  await fs.writeFile(join(root, 'bun.lock'), 'published')
  const outside = join(scratch, 'outside'); await fs.mkdir(outside)
  if (kind === 'parent') { await fs.rm(join(root, 'migrations'), { recursive: true }); await fs.symlink(outside, join(root, 'migrations')) }
  else await fs.symlink(join(root, 'bun.lock'), join(root, 'migrations/0099_upgrade.sql'))
  await saveJournal({ version: 2, files: [entry(), entry('migrations/0099_upgrade.sql')] })
  await expect(store.recover(root)).rejects.toMatchObject({ code: 'unsafe_path' })
  expect(await bytes('bun.lock')).toEqual(Buffer.from('published'))
  expect(await fs.readdir(outside)).toEqual([])
})

// Fault injection stays in filesystem spies, with no production hook or public API.
async function beforeSyscall(name: 'rename' | 'link', hook: (from: string, to: string) => Promise<void>, run: () => Promise<void>) {
  const original = fs[name]
  const stub = vi.spyOn(fs, name).mockImplementation(async (from, to) => {
    await hook(String(from), String(to))
    await original(from, to)
  })
  // Historical installation used rename; inject at the same boundary on the red revision.
  const rename = fs.rename
  const historical = name === 'link' ? vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    await hook(String(from), String(to))
    await rename(from, to)
  }) : undefined
  syncBuiltinESMExports()
  try { await run() } finally { stub.mockRestore(); historical?.mockRestore(); syncBuiltinESMExports() }
}
it.each(['bun.lock', 'package.json'])('restores captured %s after pre-link EIO without blocking recovery', async target => {
  const before = await snapshot()
  let injected = false
  await beforeSyscall('link', async (_from, to) => {
    if (!injected && to === join(root, target)) {
      injected = true
      throw Object.assign(new Error('pre-link EIO'), { code: 'EIO' })
    }
  }, async () => { await expect(commit()).rejects.toMatchObject({ code: 'EIO' }) })
  expect(injected).toBe(true)
  expect(await snapshot()).toEqual(before)
  expect(await bytes('proposals/.promotion.json')).toBeNull()
  for (const directory of [root, join(root, 'proposals')]) {
    expect((await fs.readdir(directory)).filter(name => name.includes('.conflict-'))).toEqual([])
  }
  await expect(store.recover(root)).resolves.toBeUndefined()
  expect(await snapshot()).toEqual(before)
})
it.each(['bun.lock', 'package.json'])('preserves an external creator after captured %s pre-link failure', async target => {
  const before = await snapshot(), external = Buffer.from([0x81, 0, 0xfe])
  let injected = false
  await beforeSyscall('link', async (_from, to) => {
    if (!injected && to === join(root, target)) {
      injected = true
      await fs.writeFile(to, external, { flag: 'wx' })
      throw Object.assign(new Error('pre-link EIO'), { code: 'EIO' })
    }
  }, async () => { await expect(commit()).rejects.toMatchObject({ code: 'concurrent_modification' }) })
  expect(injected).toBe(true)
  expect(await snapshot()).toEqual(before.map((value, i) => files[i].path === target ? external : value))
  const artifacts = (await fs.readdir(root)).filter(name => name.startsWith(`${target}.conflict-`))
  expect(artifacts).toHaveLength(1)
  expect(await bytes(artifacts[0])).toEqual(before[files.findIndex(file => file.path === target)])
  expect(await bytes('proposals/.promotion.json')).not.toBeNull()
  await expect(store.recover(root)).rejects.toMatchObject({ code: 'concurrent_modification' })
  expect(await bytes(target)).toEqual(external)
})
for (const format of ['v2', 'legacy', 'legacy-unhashed']) {
  const legacy = format !== 'v2'
  const recoveryJournal = (entries: { path: string; before: string | null }[]) => ({
    ...(legacy ? {} : { version: 2 }),
    files: entries.map(file => ({ ...file, before: file.before === null ? null : legacy ? file.before : Buffer.from(file.before).toString('base64'), ...(format === 'legacy-unhashed' ? {} : { afterHash: legacy ? hash('published') : rawHash('published') }) })),
  })
  it(`fences a swapped ancestor before the second restore (format=${format})`, async () => {
    const outside = join(scratch, 'outside'); await fs.mkdir(outside)
    await fs.writeFile(join(outside, '0099_upgrade.sql'), 'published')
    await fs.writeFile(join(root, 'bun.lock'), 'published')
    await fs.writeFile(join(root, 'migrations/0099_upgrade.sql'), 'published')
    await saveJournal(recoveryJournal([{ path: 'bun.lock', before: 'original' }, { path: 'migrations/0099_upgrade.sql', before: 'original' }]))
    let injected = false
    await interceptRename(async destination => {
      if (!injected && destination === join(root, 'bun.lock')) {
        injected = true
        await fs.rename(join(root, 'migrations'), join(root, 'saved-migrations'))
        await fs.symlink(outside, join(root, 'migrations'))
      }
    }, async () => { await expect(store.recover(root)).rejects.toMatchObject({ code: 'concurrent_modification' }) })
    expect(injected).toBe(true)
    expect(await fs.readFile(join(outside, '0099_upgrade.sql'), 'utf8')).toBe('published')
    expect(await fs.readdir(outside)).toEqual(['0099_upgrade.sql'])
    expect(await bytes('proposals/.promotion.json')).not.toBeNull()
  })
  it.each([null, 'original'].flatMap(before => [false, true].map(occupied => ({ before, occupied }))))(`captures external replacement before destructive syscall (format=${format}, %j)`, async ({ before, occupied }) => {
    await fs.writeFile(join(root, 'bun.lock'), 'published')
    await saveJournal(recoveryJournal([{ path: 'bun.lock', before }]))
    let injected = false
    // Hook both historical rm/overwrite and the new capture syscall for a behavioral red run.
    const rename = fs.rename, rm = fs.rm
    const stub = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!injected && [String(from), String(to)].includes(join(root, 'bun.lock'))) {
        injected = true
        await fs.writeFile(join(root, 'bun.lock'), 'external replacement')
        await rename(from, to)
        if (occupied && String(from) === join(root, 'bun.lock')) await fs.writeFile(from, 'external creator')
      } else await rename(from, to)
    })
    const removed = vi.spyOn(fs, 'rm').mockImplementation(async (path, options) => {
      if (!injected && String(path) === join(root, 'bun.lock')) {
        injected = true
        await fs.writeFile(path, 'external replacement')
      }
      await rm(path, options)
    })
    syncBuiltinESMExports()
    let error: unknown
    try { await store.recover(root) } catch (caught) { error = caught }
    finally { stub.mockRestore(); removed.mockRestore(); syncBuiltinESMExports() }
    expect(injected).toBe(true)
    expect(await bytes('bun.lock')).toEqual(Buffer.from(occupied ? 'external creator' : 'external replacement'))
    const artifacts = (await fs.readdir(root)).filter(name => name.startsWith('bun.lock.conflict-'))
    expect(artifacts).toHaveLength(occupied ? 1 : 0)
    if (occupied) expect(await bytes(artifacts[0])).toEqual(Buffer.from('external replacement'))
    expect(error).toMatchObject({ code: 'concurrent_modification' })
    expect(await bytes('proposals/.promotion.json')).not.toBeNull()
  })
  it(`preserves external creation before absent-path install (format=${format})`, async () => {
    await fs.rm(join(root, 'bun.lock'))
    await saveJournal(recoveryJournal([{ path: 'bun.lock', before: 'original' }]))
    let injected = false
    await beforeSyscall('link', async (_from, to) => {
      if (!injected && to === join(root, 'bun.lock')) { injected = true; await fs.writeFile(to, 'external creator') }
    }, async () => {
      let error: unknown
      try { await store.recover(root) } catch (caught) { error = caught }
      expect(await bytes('bun.lock')).toEqual(Buffer.from('external creator'))
      expect(error).toMatchObject({ code: 'concurrent_modification' })
    })
    expect(injected).toBe(true)
    expect(await bytes('proposals/.promotion.json')).not.toBeNull()
  })
}
it('preserves an external replacement captured during forward publication', async () => {
  let injected = false
  await beforeSyscall('rename', async (from) => {
    if (!injected && from === join(root, 'bun.lock')) { injected = true; await fs.writeFile(from, 'external replacement') }
  }, async () => { await expect(commit()).rejects.toMatchObject({ code: 'concurrent_modification' }) })
  expect(injected).toBe(true)
  expect(await bytes('bun.lock')).toEqual(Buffer.from('external replacement'))
  expect(await bytes('proposals/.promotion.json')).not.toBeNull()
})
it.each(['external creator', '-- upgrade'])('preserves external creation during forward publication of an absent path (%s)', async external => {
  let injected = false
  await beforeSyscall('link', async (_from, to) => {
    if (!injected && to === join(root, 'migrations/0099_upgrade.sql')) { injected = true; await fs.writeFile(to, external) }
  }, async () => {
    let error: unknown
    try { await commit() } catch (caught) { error = caught }
    expect(await bytes('migrations/0099_upgrade.sql')).toEqual(Buffer.from(external))
    expect(error).toMatchObject({ code: 'concurrent_modification' })
  })
  expect(injected).toBe(true)
  await expect(store.recover(root)).rejects.toMatchObject({ code: 'concurrent_modification' })
  expect(await bytes('migrations/0099_upgrade.sql')).toEqual(Buffer.from(external))
  expect(await bytes('proposals/.promotion.json')).not.toBeNull()
})
