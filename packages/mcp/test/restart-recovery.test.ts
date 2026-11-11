import { registerTempDir, cleanupTempDir } from '../../../scripts/lib/test-temp-dir.mjs'
import fs from 'node:fs/promises'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { acquireInstanceLock } from '../src/instance-lock.ts'
import { dependencySnapshot, Store } from '../src/storage.ts'
import { hash } from '../src/planning.ts'
import { copyHistoricalInstances } from './fixtures.ts'
import { Workflow } from '../src/workflow.ts'
import { captureSdkInputs } from '../src/sdk-target.ts'
import { targetProof } from './fixtures/sdk-upgrade-evidence.ts'
import { digestBytes } from '../src/sdk-upgrade-protocol.ts'

let rawScratch: string, scratch: string, root: string, before: Buffer
const children: ChildProcess[] = []
const rawHash = (value: Buffer | string) => hash(Buffer.from(value).toString('base64'))
const partial = "throw new Error('PARTIAL_CONFIG_EVALUATED_BEFORE_RECOVERY')\nexport default {}\n"
const bytes = (path: string) => fs.readFile(join(root, path)).catch(error => { if (error.code === 'ENOENT') return null; throw error })
const journal = (files: unknown[]) => fs.writeFile(join(root, 'proposals/.promotion.json'), JSON.stringify({ version: 2, files }))
const entry = (path: string, original: Buffer | null, after: Buffer | string) => ({ path, before: original?.toString('base64') ?? null, afterHash: rawHash(after) })
const restart = async (allowEmpty = false) => { const store = new Store(root); await store.init(allowEmpty); return store }
async function interrupted(missing = false) {
  await journal([entry('config.ts', before, partial)])
  if (missing) await fs.unlink(join(root, 'config.ts'))
  else await fs.writeFile(join(root, 'config.ts'), partial)
}
beforeEach(async () => {
  rawScratch = registerTempDir(await fs.mkdtemp(join(tmpdir(), 'wb-restart-')))
  scratch = await fs.realpath(rawScratch)
  await fs.writeFile(join(scratch, 'package.json'), '{"type":"module"}')
  await copyHistoricalInstances(scratch)
  root = join(scratch, 'examples/sample')
  await fs.mkdir(join(root, 'proposals'))
  before = await fs.readFile(join(root, 'config.ts'))
})
afterEach(async () => {
  vi.restoreAllMocks(); syncBuiltinESMExports()
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close'); child.kill('SIGKILL'); await closed
    }
  }
  cleanupTempDir(rawScratch)
})
async function restored(store: Store) {
  expect(await bytes('config.ts')).toEqual(before)
  expect(await bytes('proposals/.promotion.json')).toBeNull()
  // SIGKILL may leave staging/aside files; neither active lock path may remain.
  expect((await fs.readdir(join(root, 'proposals'))).filter(name => name === '.lock' || name === '.lock-claim')).toEqual([])
  expect((await store.load('sample')).config.id).toBe('sample')
  await expect(restart()).resolves.toBeInstanceOf(Store)
}

it('recovers partial config before evaluation on standalone restart (base-red)', async () => {
  await interrupted()
  const result = await restart().then(store => ({ store, error: null }), error => ({ store: null, error }))
  expect(result.error, 'init must recover before executable config is imported').toBeNull()
  await restored(result.store!)
})
it('recovers before config import, then revokes old SDK evidence on cancelled revalidation', async () => {
  await fs.writeFile(join(root, 'package.json'), '{"type":"module"}')
  await fs.writeFile(join(root, 'bun.lock'), 'fixture lock')
  const store = await restart(), latest = await store.load('sample'), inputs = await captureSdkInputs(root)
  const proposalId = crypto.randomUUID()
  const proof = await targetProof({ instanceRoot: root, checkoutRoot: resolve('.'), inputs, targetVersion: '0.2.14',
    base: { instanceId: 'sample', baseRevision: latest.config.revision, baseFingerprint: latest.fingerprint, baseDependencyDigest: latest.dependencyDigest! },
    readBase: async () => ({ baseFingerprint: latest.fingerprint, baseDependencyDigest: latest.dependencyDigest! }) })
  const proposal = { kind: 'sdk_upgrade', proposalId, instance: 'sample', baseRevision: latest.config.revision, targetVersion: '0.2.14',
    baseFingerprint: latest.fingerprint, baseDependencyDigest: latest.dependencyDigest, status: 'verified', createdAt: new Date().toISOString(),
    evidence: { ...proof, state: 'verified', proposalId, baseInputHashes: Object.fromEntries(Object.entries(inputs).map(([path, bytes]) => [path, digestBytes(bytes)])),
      artifacts: Object.fromEntries(Object.entries(proof.artifacts).map(([path, file]) => [path, { data: file.bytes.toString('base64'), sha256: file.sha256 }])) } }
  await fs.writeFile(join(root, 'proposals', `${proposalId}.json`), JSON.stringify(proposal))
  await interrupted()
  const recovered = await restart()
  expect(await bytes('config.ts')).toEqual(before)
  expect(await new Workflow(recovered).call('validate', { proposalId }, AbortSignal.abort())).toMatchObject({ error: { code: 'sdk_upgrade_cancelled' } })
  const saved = JSON.parse((await bytes(`proposals/${proposalId}.json`))!.toString())
  expect(saved.status).toBe('proposed'); expect(saved.evidence).toBeUndefined()
  expect(await captureSdkInputs(root)).toEqual(inputs)
})
it('discovers an absent config from its journal instead of entering bootstrap', async () => {
  await interrupted(true)
  const store = await restart(true)
  expect([...store.allowed]).toEqual(['sample'])
  await restored(store)
})
it.each([false, true])('restores manifest and lock exact bytes / original absence (absent=%s)', async absent => {
  const manifest = Buffer.from('{"type":"module"}\r\n'), lock = Buffer.from([0xff, 0, 0x80, 13, 10])
  await fs.writeFile(join(root, 'package.json'), '{"type":"module","partial":true}')
  await fs.writeFile(join(root, 'bun.lock'), 'partial lock')
  await journal([entry('package.json', absent ? null : manifest, '{"type":"module","partial":true}'), entry('bun.lock', absent ? null : lock, 'partial lock')])
  const store = await restart()
  expect(await bytes('package.json')).toEqual(absent ? null : manifest)
  expect(await bytes('bun.lock')).toEqual(absent ? null : lock)
  expect((await store.load('sample')).dependencyDigest).toBe((await dependencySnapshot(root)).digest)
  expect(await bytes('proposals/.promotion.json')).toBeNull()
})
it.each([1, 2, 3, 4])('recovers an interrupted SDK publication after %s writes, including its proposal transition', async count => {
  const proposalId = crypto.randomUUID(), proposalPath = `proposals/${proposalId}.json`
  const original = Buffer.from('{"kind":"sdk_upgrade","status":"verified"}\r\n')
  const files = [
    { path: 'package.json', before: Buffer.from('{"type":"module"}\r\n'), after: Buffer.from('{"type":"module","target":true}') },
    { path: 'bun.lock', before: Buffer.from([0xff, 0, 0x80]), after: Buffer.from([0xfe, 13, 10]) },
    { path: 'migrations/0002_sdk_upgrade.sql', before: null, after: Buffer.from('-- exact marker\r\nSELECT 1;\n') },
    { path: proposalPath, before: original, after: Buffer.from('{"kind":"sdk_upgrade","status":"promoted"}\n') },
  ]
  for (const file of files) if (file.before) await fs.writeFile(join(root, file.path), file.before)
  const base = await captureSdkInputs(root)
  await journal(files.map(file => entry(file.path, file.before, file.after)))
  for (const file of files.slice(0, count)) await fs.writeFile(join(root, file.path), file.after)
  await restart()
  expect(await captureSdkInputs(root)).toEqual(base)
  expect(await bytes(proposalPath)).toEqual(original)
  expect(await bytes('proposals/.promotion.json')).toBeNull()
})

// All process coordination uses IPC barriers and close events, never sleeps.
async function holder(reclaimer: boolean | 'dead-claim' = false, checkpoint: 'claim-published' | 'replacement-owner' | 'captured-claim' | 'restore-claim' | undefined = undefined) {
  const script = join(scratch, `${crypto.randomUUID()}.mts`)
  await fs.writeFile(script, `
    import { acquireInstanceLock } from ${JSON.stringify(resolve('packages/mcp/src/instance-lock.ts'))}
    import fs from 'node:fs/promises'
    import { syncBuiltinESMExports } from 'node:module'
    if (${!!reclaimer}) {
      const checkpoint = ${JSON.stringify(checkpoint ?? null)}
      const deadClaim = ${reclaimer === 'dead-claim'}
      const claim = ${JSON.stringify(join(root, 'proposals/.lock-claim'))}
      const pause = async name => {
        process.send(name)
        await new Promise(resolve => process.once('message', message => {
          if (message !== 'claim') throw new Error('unexpected claim barrier message')
          resolve()
        }))
      }
      const mkdir = fs.mkdir
      fs.mkdir = async (path, options) => {
        if (!checkpoint && String(path) === claim) await pause('observed-dead-owner')
        return mkdir(path, options)
      }
      const link = fs.link
      fs.link = async (source, target) => {
        if (!checkpoint && !deadClaim && String(target) === claim) await pause('observed-dead-owner')
        if (checkpoint === 'restore-claim' && String(target) === claim) {
          // Model link resolving its source inode before a concurrent unlink,
          // then publishing its target after that unlink has completed.
          const resolved = source + '.resolved'
          await link(source, resolved)
          await pause(checkpoint)
          try { return await link(resolved, target) }
          finally { await fs.unlink(resolved) }
        }
        const result = await link(source, target)
        if (checkpoint === 'claim-published' && String(target) === claim) await pause(checkpoint)
        return result
      }
      let observedClaim = false
      const rename = fs.rename
      fs.rename = async (source, target) => {
        let captured = false
        if (deadClaim && !observedClaim && String(source) === claim) {
          observedClaim = true
          captured = true
          await pause('observed-dead-claim')
        }
        const result = await rename(source, target)
        if (captured && checkpoint === 'captured-claim') await pause(checkpoint)
        return result
      }
      const writeFile = fs.writeFile
      fs.writeFile = async (path, ...args) => {
        const result = await writeFile(path, ...args)
        // The directory-format branch makes this regression runnable on 3beedbf3.
        if (checkpoint === 'claim-published' && String(path).startsWith(claim + '/')) await pause(checkpoint)
        if (checkpoint === 'replacement-owner' && String(path).includes('/.lock/owner-')) await pause(checkpoint)
        return result
      }
      syncBuiltinESMExports()
    }
    let release = ${reclaimer ? 'undefined' : `await acquireInstanceLock(${JSON.stringify(root)})`}

    process.on('message', async message => {
      if (message === 'go') {
        try { release = await acquireInstanceLock(${JSON.stringify(root)}); process.send('acquired') }
        catch (error) { process.send(error.code); process.disconnect() }
      }
      if (message === 'release') { await release(); process.send('released'); process.disconnect() }
    })
    process.send('ready')
  `)
  const child = spawn(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), script], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  children.push(child)
  let stderr = ''; child.stderr!.on('data', data => { stderr += data })
  const ready = await Promise.race([once(child, 'message').then(([message]) => message), once(child, 'exit').then(() => { throw new Error(`holder exited before barrier: ${stderr}`) })])
  expect(ready).toBe('ready')
  return child
}
async function kill(child: ChildProcess) { const closed = once(child, 'close'); child.kill('SIGKILL'); await closed }
async function metadata() {
  const directory = join(root, 'proposals/.lock')
  const name = (await fs.readdir(directory)).find(name => name.startsWith('owner-'))!
  const path = join(directory, name)
  return { path, value: JSON.parse(await fs.readFile(path, 'utf8')) }
}
it('recovers a killed owner before config evaluation (base-red)', async () => {
  await interrupted()
  const child = await holder()
  expect((await metadata()).value.pid).toBe(child.pid)
  await kill(child)
  const result = await restart().then(store => ({ store, error: null }), error => ({ store: null, error }))
  expect(result.error, 'demonstrably dead owner must permit startup recovery').toBeNull()
  await restored(result.store!)
})
it.each(['claim-published', 'replacement-owner'] as const)('recovers journal after reclaimer SIGKILL at %s (review regression)', async checkpoint => {
  await kill(await holder())
  await interrupted()
  const reclaimer = await holder(true, checkpoint), stopped = once(reclaimer, 'message')
  reclaimer.send('go')
  expect((await stopped)[0]).toBe(checkpoint)
  if (checkpoint === 'replacement-owner') expect((await metadata()).value.pid).toBe(reclaimer.pid)
  await kill(reclaimer)
  const result = await restart().then(store => ({ store, error: null }), error => ({ store: null, error }))
  expect(result.error, 'dead claimant must permit journal recovery before config evaluation').toBeNull()
  await restored(result.store!)
})
async function abandonedClaim() {
  await kill(await holder())
  const child = await holder(true, 'replacement-owner'), published = once(child, 'message')
  child.send('go')
  expect((await published)[0]).toBe('replacement-owner')
  await kill(child)
  return join(root, 'proposals/.lock-claim')
}
async function installClaim(path: string, value: string) {
  await fs.unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error })
  await fs.writeFile(path, value, { flag: 'wx', mode: 0o600 })
  const owner = JSON.parse(value)
  if (owner.fenced) await fs.link(path, `${path}.${owner.token}.active`)
}
it('keeps a live claimant busy regardless of claim age', async () => {
  await kill(await holder())
  await interrupted()
  const child = await holder(true, 'claim-published'), published = once(child, 'message')
  child.send('go')
  expect((await published)[0]).toBe('claim-published')
  const claim = join(root, 'proposals/.lock-claim')
  const owner = JSON.parse(await fs.readFile(claim, 'utf8'))
  expect(owner).toMatchObject({ version: 1, pid: child.pid, host: (await metadata()).value.host, boot: (await metadata()).value.boot })
  expect(owner.token).toMatch(/^[a-f0-9-]{36}$/)
  if (process.platform === 'linux') expect(owner.start).toMatch(/^\d+$/)
  const stat = await fs.lstat(claim)
  expect(stat.isFile()).toBe(true)
  expect(stat.mode & 0o777).toBe(0o600)
  const past = new Date('2000-01-01')
  await fs.utimes(claim, past, past)
  await expect(restart()).rejects.toMatchObject({ code: 'instance_busy' })
  expect(await bytes('config.ts')).toEqual(Buffer.from(partial))
  expect(await bytes('proposals/.promotion.json')).not.toBeNull()
  await kill(child)
  await restored(await restart())
})
it('allows exactly one of two simultaneous takeovers of a dead claim', async () => {
  await abandonedClaim()
  await interrupted()
  const contenders = await Promise.all([holder('dead-claim'), holder('dead-claim')])
  const closed = contenders.map(child => once(child, 'close'))
  const observed = contenders.map(child => once(child, 'message'))
  for (const child of contenders) child.send('go')
  expect((await Promise.all(observed)).map(([message]) => message)).toEqual(['observed-dead-claim', 'observed-dead-claim'])
  const outcomes = contenders.map(child => once(child, 'message'))
  for (const child of contenders) child.send('claim')
  const results = (await Promise.all(outcomes)).map(([message]) => message)
  expect([...results].sort()).toEqual(['acquired', 'instance_busy'])
  await expect(restart()).rejects.toMatchObject({ code: 'instance_busy' })
  expect(await bytes('config.ts')).toEqual(Buffer.from(partial))
  const winner = contenders[results.indexOf('acquired')], released = once(winner, 'message')
  winner.send('release'); expect((await released)[0]).toBe('released')
  await Promise.all(closed)
  await restored(await restart())
})
it.each(['legacy directory', 'malformed JSON', 'incomplete metadata', 'symlink', 'unreadable'])('fails closed on %s claim before config evaluation', async kind => {
  await kill(await holder())
  await interrupted()
  const claim = join(root, 'proposals/.lock-claim')
  if (kind === 'legacy directory') await fs.mkdir(claim)
  else if (kind === 'symlink') await fs.symlink((await metadata()).path, claim)
  else await fs.writeFile(claim, kind === 'unreadable' ? await fs.readFile((await metadata()).path) : kind === 'malformed JSON' ? '{' : JSON.stringify({ version: 1, token: crypto.randomUUID() }))
  if (kind === 'unreadable') {
    const open = fs.open
    vi.spyOn(fs, 'open').mockImplementation(async (path, ...args) => {
      if (String(path) === claim) throw Object.assign(new Error('unreadable claim'), { code: 'EACCES' })
      return open(path, ...args)
    })
    syncBuiltinESMExports()
  }
  await expect(restart()).rejects.toMatchObject({ code: kind === 'legacy directory' ? 'legacy_lock_claim' : 'invalid_lock_claim', message: expect.stringContaining(claim) })
  expect(await fs.lstat(claim)).toBeDefined()
  expect(await bytes('config.ts')).toEqual(Buffer.from(partial))
  expect(await bytes('proposals/.promotion.json')).not.toBeNull()
})
it.each(['foreign host', 'foreign boot', 'unknown boot', 'unknown start'])('keeps a claim with %s busy', async kind => {
  const claim = await abandonedClaim(), owner = JSON.parse(await fs.readFile(claim, 'utf8'))
  if (kind === 'foreign host') owner.host += '-elsewhere'
  if (kind === 'foreign boot') owner.boot += '-elsewhere'
  if (kind === 'unknown boot') owner.boot = null
  // An existing pid without a start identity cannot be proven dead.
  if (kind === 'unknown start') { owner.pid = process.pid; owner.start = null }
  const original = JSON.stringify(owner)
  await fs.writeFile(claim, original)
  await interrupted()
  await expect(restart()).rejects.toMatchObject({ code: 'instance_busy' })
  expect(await fs.readFile(claim, 'utf8')).toBe(original)
  expect(await bytes('config.ts')).toEqual(Buffer.from(partial))
  expect(await bytes('proposals/.promotion.json')).not.toBeNull()
})
it.each([false, true])('restores a successor captured by a stale dead-claim observer (fenced=%s)', async fenced => {
  const claim = await abandonedClaim(), dead = await fs.readFile(claim, 'utf8')
  const successor = JSON.stringify({ ...JSON.parse(dead), token: crypto.randomUUID(), pid: process.pid, start: null, fenced: fenced || undefined })
  const rename = fs.rename
  let replaced = false
  const stub = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
    if (!replaced && String(source) === claim) {
      replaced = true
      await installClaim(claim, successor)
    }
    return rename(source, target)
  })
  syncBuiltinESMExports()
  try { await expect(acquireInstanceLock(root)).rejects.toMatchObject({ code: 'instance_busy' }) }
  finally { stub.mockRestore(); syncBuiltinESMExports() }
  expect(replaced).toBe(true)
  expect(await fs.readFile(claim, 'utf8')).toBe(successor)
})
it.each([false, true])('preserves a newer claim when restoring a captured successor is contended (fenced=%s)', async fenced => {
  const claim = await abandonedClaim(), dead = JSON.parse(await fs.readFile(claim, 'utf8'))
  const successor = JSON.stringify({ ...dead, token: crypto.randomUUID(), pid: process.pid, start: null, fenced: fenced || undefined })
  const newer = JSON.stringify({ ...JSON.parse(successor), token: crypto.randomUUID() })
  const rename = fs.rename
  let aside: string | undefined
  const stub = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
    if (!aside && String(source) === claim) {
      aside = String(target)
      await installClaim(claim, successor)
      await rename(source, target)
      await installClaim(claim, newer)
      return
    }
    return rename(source, target)
  })
  syncBuiltinESMExports()
  try { await expect(acquireInstanceLock(root)).rejects.toMatchObject({ code: 'instance_busy' }) }
  finally { stub.mockRestore(); syncBuiltinESMExports() }
  expect(await fs.readFile(claim, 'utf8')).toBe(newer)
  expect(await fs.readFile(aside!, 'utf8')).toBe(successor)
})
it.each([false, true])('removes only its own claim when a successor appears at the release rename boundary (fenced=%s)', async fenced => {
  await kill(await holder())
  const claim = join(root, 'proposals/.lock-claim'), rename = fs.rename
  let successor: string | undefined
  const stub = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
    if (!successor && String(source) === claim) {
      const owner = JSON.parse(await fs.readFile(claim, 'utf8'))
      successor = JSON.stringify({ ...owner, token: crypto.randomUUID(), fenced: fenced || undefined })
      await installClaim(claim, successor)
    }
    return rename(source, target)
  })
  syncBuiltinESMExports()
  try { await expect(acquireInstanceLock(root)).rejects.toMatchObject({ code: 'instance_busy' }) }
  finally { stub.mockRestore(); syncBuiltinESMExports() }
  expect(successor).toBeDefined()
  expect(await fs.readFile(claim, 'utf8')).toBe(successor)
})
it.each(['captured-claim', 'restore-claim'] as const)('does not restore a finished acquisition at %s (round2-a)', async checkpoint => {
  const claim = await abandonedClaim()
  const observer = await holder('dead-claim', checkpoint), observed = once(observer, 'message')
  observer.send('go'); expect((await observed)[0]).toBe('observed-dead-claim')
  const open = fs.open, writeFile = fs.writeFile, unlink = fs.unlink
  let published = false, captured = false
  const capture = async () => {
    captured = true
    const stopped = once(observer, 'message')
    observer.send('claim'); expect((await stopped)[0]).toBe(checkpoint)
  }
  vi.spyOn(fs, 'writeFile').mockImplementation(async (path, ...args) => {
    const result = await writeFile(path, ...args)
    if (String(path).includes('/.lock/owner-')) published = true
    return result
  })
  vi.spyOn(fs, 'open').mockImplementation(async (path, ...args) => {
    // claimAt has already completed lstat; the stale observer now captures B.
    // Fallback for restore-claim when fence retirement is bypassed: release
    // still reads the public claim after publishing its owner. Share the latch
    // with the earlier unlink barrier so the observer is advanced only once.
    if (String(path) === claim && published && !captured) await capture()
    return open(path, ...args)
  })
  vi.spyOn(fs, 'unlink').mockImplementation(async path => {
    if (checkpoint === 'restore-claim' && String(path).endsWith('.active') && published && !captured) await capture()
    return unlink(path)
  })
  syncBuiltinESMExports()
  const release = await acquireInstanceLock(root)
  await release()
  vi.restoreAllMocks(); syncBuiltinESMExports()
  expect(captured).toBe(true)
  // B has finished and released its owner lock, but its pid remains alive.
  const outcome = once(observer, 'message'), closed = once(observer, 'close')
  observer.send('claim'); expect((await outcome)[0]).toBe('instance_busy'); await closed
  const next = await acquireInstanceLock(root)
  await next()
  expect(await bytes('proposals/.lock-claim')).toBeNull()
})
it.each(['claim-release', 'owner-write'] as const)('removes owner metadata when acquisition rejects at %s after publishing it (round2-b)', async checkpoint => {
  await kill(await holder())
  const claim = join(root, 'proposals/.lock-claim'), rename = fs.rename, writeFile = fs.writeFile
  let published: string | undefined, rejected = false
  const capturedOwners: string[] = []
  vi.spyOn(fs, 'writeFile').mockImplementation(async (path, ...args) => {
    const result = await writeFile(path, ...args)
    if (String(path).includes('/.lock/owner-')) {
      published = String(path)
      if (checkpoint === 'owner-write') {
        rejected = true
        throw new Error('CLAIM_RELEASE_FAILED')
      }
    }
    return result
  })
  vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
    if (String(source) === published) capturedOwners.push(String(target))
    if (published && !rejected && String(source) === claim) {
      rejected = true
      throw Object.assign(new Error('CLAIM_RELEASE_FAILED'), { code: 'EIO' })
    }
    return rename(source, target)
  })
  syncBuiltinESMExports()
  try { await expect(acquireInstanceLock(root)).rejects.toThrow('CLAIM_RELEASE_FAILED') }
  finally { vi.restoreAllMocks(); syncBuiltinESMExports() }
  expect(rejected).toBe(true)
  expect(published).toBeDefined()
  expect(await fs.readFile(published!).catch(error => { if (error.code === 'ENOENT') return null; throw error })).toBeNull()
  expect(capturedOwners).toHaveLength(1)
  const next = await acquireInstanceLock(root)
  await next()
})
it.runIf(process.platform === 'linux')('reclaims a claim with a reused pid only on /proc start-identity mismatch', async () => {
  const release = await acquireInstanceLock(root), owner = (await metadata()).value
  expect(owner.start).toMatch(/^\d+$/)
  const claim = { ...owner, token: crypto.randomUUID(), start: String(BigInt(owner.start) + 1n) }
  await release()
  await fs.writeFile(join(root, 'proposals/.lock-claim'), JSON.stringify(claim))
  await interrupted()
  await restored(await restart())
})
it('keeps a live child busy regardless of lock age and releases at a barrier', async () => {
  const child = await holder()
  const past = new Date('2000-01-01')
  await fs.utimes(join(root, 'proposals/.lock'), past, past)
  await interrupted()
  await expect(restart()).rejects.toMatchObject({ code: 'instance_busy' })
  expect(await bytes('config.ts')).toEqual(Buffer.from(partial))
  const released = once(child, 'message'), closed = once(child, 'close')
  child.send('release'); expect((await released)[0]).toBe('released'); await closed
  await restored(await restart())
})
it('serializes two simultaneous reclaimers and keeps the winner exclusively owned', async () => {
  await kill(await holder())
  const contenders = await Promise.all([holder(true), holder(true)])
  const closed = contenders.map(child => once(child, 'close'))
  const observed = contenders.map(child => once(child, 'message'))
  for (const child of contenders) child.send('go')
  expect((await Promise.all(observed)).map(([message]) => message)).toEqual(['observed-dead-owner', 'observed-dead-owner'])
  const outcomes = contenders.map(child => once(child, 'message'))
  for (const child of contenders) child.send('claim')
  const results = (await Promise.all(outcomes)).map(([message]) => message)
  expect([...results].sort()).toEqual(['acquired', 'instance_busy'])
  await expect(acquireInstanceLock(root)).rejects.toMatchObject({ code: 'instance_busy' })
  const winner = contenders[results.indexOf('acquired')], released = once(winner, 'message')
  winner.send('release'); expect((await released)[0]).toBe('released')
  await Promise.all(closed)
  await restored(await restart())
})
it('never removes a replacement acquisition during release', async () => {
  const release = await acquireInstanceLock(root)
  const lock = join(root, 'proposals/.lock'), saved = join(root, 'proposals/old-lock')
  await fs.rename(lock, saved)
  const successor = await acquireInstanceLock(root)
  const current = await metadata()
  await release()
  expect(await fs.readFile(current.path, 'utf8')).toBe(JSON.stringify(current.value))
  await successor()
})
it('checks the acquisition token as well as directory identity on release', async () => {
  const release = await acquireInstanceLock(root), current = await metadata()
  const token = crypto.randomUUID(), replacement = join(root, 'proposals/.lock', `owner-${token}.json`)
  await fs.unlink(current.path)
  await fs.writeFile(replacement, JSON.stringify({ ...current.value, token }))
  await release()
  expect(await fs.readFile(replacement, 'utf8')).toContain(token)
})
it.each(['empty legacy', 'incomplete', 'malformed', 'foreign host', 'foreign boot', 'unknown boot', 'unknown start'])('keeps %s ownership busy without evaluating config', async kind => {
  if (['empty legacy', 'incomplete', 'malformed'].includes(kind)) {
    await fs.mkdir(join(root, 'proposals/.lock'))
    if (kind !== 'empty legacy') await fs.writeFile(join(root, 'proposals/.lock', `owner-${crypto.randomUUID()}.json`), kind === 'incomplete' ? JSON.stringify({ version: 1, token: crypto.randomUUID() }) : '{')
  } else {
    if (kind === 'unknown start') await acquireInstanceLock(root)
    else await kill(await holder())
    const current = await metadata()
    if (kind === 'foreign host') current.value.host += '-elsewhere'
    if (kind === 'foreign boot') current.value.boot += '-elsewhere'
    if (kind === 'unknown boot') current.value.boot = null
    if (kind === 'unknown start') current.value.start = null
    await fs.writeFile(current.path, JSON.stringify(current.value))
  }
  await interrupted()
  await expect(restart()).rejects.toMatchObject({ code: 'instance_busy' })
  expect(await bytes('config.ts')).toEqual(Buffer.from(partial))
  expect(await bytes('proposals/.promotion.json')).not.toBeNull()
})
it.runIf(process.platform === 'linux')('reclaims a reused pid only with a demonstrably different start identity', async () => {
  await acquireInstanceLock(root)
  const current = await metadata()
  current.value.start = String(BigInt(current.value.start) + 1n)
  await fs.writeFile(current.path, JSON.stringify(current.value))
  const release = await acquireInstanceLock(root)
  expect((await metadata()).value.token).not.toBe(current.value.token)
  await release()
})
it('treats uncertain process visibility as busy', async () => {
  const release = await acquireInstanceLock(root)
  const stub = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('hidden'), { code: 'EPERM' }) })
  try { await expect(acquireInstanceLock(root)).rejects.toMatchObject({ code: 'instance_busy' }) }
  finally { stub.mockRestore(); await release() }
})
it.each(['malformed', 'duplicate', 'unsafe', 'symlink file', 'symlink parent', 'conflict'])('fails closed before startup config evaluation for %s journal', async kind => {
  await fs.writeFile(join(root, 'config.ts'), partial)
  const file = entry('bun.lock', Buffer.from('original'), 'published')
  await fs.writeFile(join(root, 'bun.lock'), kind === 'conflict' ? 'external edit' : 'published')
  let code = kind === 'conflict' ? 'concurrent_modification' : 'invalid_journal'
  if (kind === 'malformed') await fs.writeFile(join(root, 'proposals/.promotion.json'), '{')
  else if (kind === 'duplicate') await journal([file, file])
  else if (kind === 'unsafe') await journal([file, { ...file, path: '../outside' }])
  else if (kind.startsWith('symlink')) {
    code = 'unsafe_path'
    const outside = join(scratch, 'outside'); await fs.mkdir(outside)
    if (kind === 'symlink parent') { await fs.rm(join(root, 'migrations'), { recursive: true }); await fs.symlink(outside, join(root, 'migrations')) }
    else await fs.symlink(join(root, 'bun.lock'), join(root, 'migrations/0099_upgrade.sql'))
    await journal([file, entry('migrations/0099_upgrade.sql', null, 'published')])
  } else await journal([file])
  await expect(restart()).rejects.toMatchObject({ code })
  expect(await bytes('config.ts')).toEqual(Buffer.from(partial))
  expect(await bytes('bun.lock')).toEqual(Buffer.from(kind === 'conflict' ? 'external edit' : 'published'))
  expect(await bytes('proposals/.promotion.json')).not.toBeNull()
})

it('holds the owner lock throughout executable config evaluation', async () => {
  const observed = join(scratch, 'evaluated.json')
  await fs.writeFile(join(root, 'config.ts'), `
    import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
    const lock = ${JSON.stringify(join(root, 'proposals/.lock'))}
    const name = readdirSync(lock).find(name => name.startsWith('owner-'))
    writeFileSync(${JSON.stringify(observed)}, readFileSync(lock + '/' + name))
    export { default } from './config.v2'
  `)
  await restart()
  expect(JSON.parse(await fs.readFile(observed, 'utf8'))).toMatchObject({ version: 1, pid: process.pid })
})
it('preserves a successor installed at the release syscall boundary', async () => {
  const release = await acquireInstanceLock(root), old = await metadata()
  let successor: (() => Promise<void>) | undefined, replaced = false
  const unlink = fs.unlink
  const stub = vi.spyOn(fs, 'unlink').mockImplementation(async path => {
    if (!replaced && String(path) === old.path) {
      replaced = true
      await fs.rename(join(root, 'proposals/.lock'), join(root, 'proposals/saved-lock'))
      successor = await acquireInstanceLock(root)
    }
    return unlink(path)
  })
  syncBuiltinESMExports()
  try { await release() } finally { stub.mockRestore(); syncBuiltinESMExports() }
  expect(replaced).toBe(true)
  expect((await metadata()).value.token).not.toBe(old.value.token)
  await successor!()
})
it('a stale reclaimer never removes a successor after observing dead ownership', async () => {
  await kill(await holder())
  const old = await metadata(), link = fs.link
  let successor: (() => Promise<void>) | undefined, replaced = false
  const stub = vi.spyOn(fs, 'link').mockImplementation(async (source, target) => {
    if (!replaced && String(target) === join(root, 'proposals/.lock-claim')) {
      replaced = true
      await fs.rename(join(root, 'proposals/.lock'), join(root, 'proposals/saved-lock'))
      successor = await acquireInstanceLock(root)
    }
    return link(source, target)
  })
  syncBuiltinESMExports()
  try { await expect(acquireInstanceLock(root)).rejects.toMatchObject({ code: 'instance_busy' }) }
  finally { stub.mockRestore(); syncBuiltinESMExports() }
  expect(replaced).toBe(true)
  expect((await metadata()).value.token).not.toBe(old.value.token)
  await successor!()
})
it('locks and recovers direct loads after startup without reusing validation proofs', async () => {
  const store = await restart()
  const proof = Buffer.from('{"validation":{"fingerprint":"old"},"verification":{"fingerprint":"old"}}')
  await fs.writeFile(join(root, 'proposals/abcd.json'), proof)
  await interrupted()
  await expect(store.load('sample')).resolves.toMatchObject({ config: { id: 'sample' } })
  expect(await bytes('proposals/abcd.json')).toEqual(proof)
  expect(await bytes('proposals/.promotion.json')).toBeNull()
})
it('rejects a symlinked proposals directory before creating a recovery lock outside the Instance', async () => {
  const outside = join(scratch, 'outside'); await fs.mkdir(outside)
  await fs.rm(join(root, 'proposals'), { recursive: true })
  await fs.symlink(outside, join(root, 'proposals'))
  await expect(new Store(root).recover(root)).rejects.toMatchObject({ code: 'unsafe_path' })
  expect(await fs.readdir(outside)).toEqual([])
})
