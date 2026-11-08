import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readdir, readFile, readlink, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { fail } from './schemas.ts'
import { noLink } from './paths.ts'

const ownerSchema = z.strictObject({
  version: z.literal(1), token: z.uuid(), pid: z.number().int().positive(),
  start: z.string().min(1).nullable(), host: z.string().min(1), boot: z.string().min(1).nullable(),
  fenced: z.literal(true).optional(), // Absent on claims from the previous protocol.
})
type Identity = { dev: number; ino: number }
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino
const busy = (): never => fail('instance_busy', 'Another configuration operation holds this instance lock', 409)
const identity = async (path: string) => {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) busy()
  return { dev: stat.dev, ino: stat.ino }
}
const matches = async (path: string, expected: Identity) => {
  try { return same(await identity(path), expected) } catch { return false }
}
async function startIdentity(pid: number) {
  if (process.platform !== 'linux') return null
  try {
    // comm is parenthesized and may itself contain spaces or parentheses.
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return /^\d+$/.test(fields[19]) ? fields[19] : null // field 22, starttime
  } catch { return null }
}
async function scope() {
  let boot: string | null = null
  try {
    if (process.platform === 'linux') boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
    else if (process.platform === 'darwin') boot = (await promisify(execFile)('/usr/sbin/sysctl', ['-n', 'kern.boottime'])).stdout.trim()
  } catch { /* Unknown boot scope forbids reclamation. */ }
  let host = hostname()
  if (process.platform === 'linux') {
    try {
      // PID numbers are comparable only in the same PID namespace. Hostname
      // alone is insufficient on shared-boot container hosts.
      host += `:${await readlink('/proc/self/ns/pid')}`
    } catch { boot = null }
  }
  return { host, boot: boot || null }
}
async function ownerAt(path: string) {
  try {
    const names = await readdir(path)
    const owners = names.filter(name => /^owner-[a-f0-9-]+\.json$/.test(name))
    if (owners.length !== 1 || names.length !== 1) return null
    const file = join(path, owners[0])
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      if (!(await handle.stat()).isFile()) return null
      const parsed = ownerSchema.safeParse(JSON.parse(await handle.readFile('utf8')))
      return parsed.success && owners[0] === `owner-${parsed.data.token}.json` ? parsed.data : null
    } finally { await handle.close() }
  } catch { return null }
}
async function dead(owner: z.infer<typeof ownerSchema>) {
  const local = await scope()
  if (!local.boot || owner.host !== local.host || owner.boot !== local.boot) return false
  try { process.kill(owner.pid, 0) }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
  const start = await startIdentity(owner.pid)
  // EPERM, missing proc visibility and unavailable/low-resolution identities stay busy.
  return owner.start !== null && start !== null && start !== owner.start
}
// Remove only this acquisition's unique metadata, then an empty directory. Never
// recursively remove a path that a successor may have acquired in the meantime.
async function removeOwned(path: string, expected: Identity, token: string, capture = false) {
  if (!await matches(path, expected) || (await ownerAt(path))?.token !== token) return false
  const file = join(path, `owner-${token}.json`)
  try {
    if (capture) {
      const metadata = await claimAt(file)
      if (!metadata || metadata.owner.token !== token) return false
      await unlink(await captureClaim(file, metadata))
    } else await unlink(file)
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  return true
}

type Owner = z.infer<typeof ownerSchema>
type Claim = { owner: Owner; bytes: Buffer }
const claimFence = (path: string, token: string) => `${path}.${token}.active`
const invalidClaim = (path: string): never => fail('invalid_lock_claim', `Invalid or unreadable lock claim metadata: ${path}`, 500)
async function claimAt(path: string): Promise<Claim | null> {
  let stat
  try { stat = await lstat(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return invalidClaim(path)
  }
  if (stat.isDirectory()) fail('legacy_lock_claim', `Unknown legacy lock claim directory: ${path}`, 500)
  if (!stat.isFile() || stat.isSymbolicLink()) return invalidClaim(path)
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    if (!(await handle.stat()).isFile()) return invalidClaim(path)
    const bytes = await handle.readFile()
    const parsed = ownerSchema.safeParse(JSON.parse(bytes.toString('utf8')))
    if (!parsed.success) return invalidClaim(path)
    return { owner: parsed.data, bytes }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return invalidClaim(path)
  } finally { await handle?.close() }
}
async function inProgress(path: string, claim: Claim) {
  if (!claim.owner.fenced) return true
  const fence = await claimAt(claimFence(path, claim.owner.token))
  if (fence && !fence.bytes.equals(claim.bytes)) return invalidClaim(path)
  return fence !== null
}
// Capture before deleting. A stale observer may have renamed a successor instead;
// restore it without overwriting any still newer claim, and leave the aside on
// contention so unchecked bytes are never discarded.
async function captureClaim(path: string, expected: Claim) {
  const aside = `${path}.${crypto.randomUUID()}.aside`
  try { await rename(path, aside) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return busy(); throw error }
  let captured: Claim | null = null
  try { captured = await claimAt(aside) }
  finally {
    if (!captured?.bytes.equals(expected.bytes)) {
      // For fenced claims the ONLY restoration source is the private active
      // link. Release retires it before inspecting the public claim. Recheck
      // after linking too: an in-flight link may already have resolved its
      // source inode when release unlinks the fence.
      const source = captured?.owner.fenced ? claimFence(path, captured.owner.token) : aside
      if (captured && !await inProgress(path, captured)) await unlink(aside)
      else {
        try {
          await link(source, path)
          await unlink(aside)
          if (captured?.owner.fenced && !await inProgress(path, captured)) {
            // Capture/verify again rather than unlinking a successor that may
            // now occupy the public pathname. Every recursive restore uses
            // the same fence checks.
            await unlink(await captureClaim(path, captured))
          }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'ENOENT' && captured?.owner.fenced) await unlink(aside)
          else if (code !== 'EEXIST') throw error
        }
      }
    }
  }
  if (!captured?.bytes.equals(expected.bytes)) return busy()
  return aside
}
async function publishClaim(path: string, owner: Owner) {
  // This private staging file remains the restoration fence until release.
  const temporary = claimFence(path, owner.token)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    try { await handle.writeFile(JSON.stringify(owner)); await handle.sync() }
    finally { await handle.close() }
    try { await link(temporary, path) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return busy(); throw error }
  } catch (error) { await unlink(temporary); throw error }
}
async function releaseClaim(path: string, token: string) {
  // The single commit point: any later restore must discard this retired token.
  try { await unlink(claimFence(path, token)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const current = await claimAt(path)
  if (!current || current.owner.token !== token) return
  await unlink(await captureClaim(path, current))
}
async function newOwner(): Promise<Owner> {
  return { version: 1, token: crypto.randomUUID(), pid: process.pid, start: await startIdentity(process.pid), ...await scope() }
}

/** Stop old MCP processes when adopting this protocol: legacy locks stay busy. */
export async function acquireInstanceLock(directory: string): Promise<() => Promise<void>> {
  await noLink(directory)
  await noLink(join(directory, 'proposals'))
  const path = join(directory, 'proposals', '.lock')
  const claim = join(directory, 'proposals', '.lock-claim')
  let claimed: string | undefined
  let release: (() => Promise<void>) | undefined
  let abandon: (() => Promise<void>) | undefined
  const takeClaim = async () => {
    const claimant = { ...await newOwner(), fenced: true as const }
    claimed = claimant.token
    await publishClaim(claim, claimant)
  }
  try {
    const previous = await claimAt(claim)
    if (previous) {
      // A missing fence proves explicit retirement, not process death. An
      // active or older unfenced claimant still requires proof of death.
      if (await inProgress(claim, previous) && !await dead(previous.owner)) busy()
      const aside = await captureClaim(claim, previous)
      try {
        if (previous.owner.fenced) await unlink(claimFence(claim, previous.owner.token)).catch(error => {
          if (error.code !== 'ENOENT') throw error
        })
        await takeClaim()
      } finally { await unlink(aside) }
    }
    try { await mkdir(path, { mode: 0o700 }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const observed = await identity(path).catch(() => busy())
      const owner = await ownerAt(path)
      if (!owner) fail('instance_busy', `Invalid or unreadable lock owner metadata: ${path}`, 409)
      if (!await dead(owner)) busy()
      // Keep the sibling claim across removal AND replacement of the lock.
      // In-progress claimants require proof of death before takeover.
      if (!claimed) await takeClaim()
      if (!await matches(path, observed) || (await ownerAt(path))?.token !== owner.token || !await dead(owner)) busy()
      if (!await removeOwned(path, observed, owner.token) || !await matches(path, observed)) busy()
      try { await rmdir(path); await mkdir(path, { mode: 0o700 }) } catch { busy() }
    }
    // Failure or death before metadata completion leaves an uncertain, busy lock.
    const acquired = await identity(path)
    const owner = await newOwner()
    const unlock = async (capture: boolean) => {
      if (await removeOwned(path, acquired, owner.token, capture) && await matches(path, acquired)) await rmdir(path)
    }
    release = () => unlock(false)
    abandon = () => unlock(true)
    await writeFile(join(path, `owner-${owner.token}.json`), JSON.stringify(owner), { flag: 'wx', mode: 0o600 })
    if (claimed) await releaseClaim(claim, claimed)
    return release
  } catch (error) {
    // Even a claim-release failure must not lose the owner release handle.
    try { if (claimed) await releaseClaim(claim, claimed) }
    finally { await abandon?.() }
    throw error
  }
}
