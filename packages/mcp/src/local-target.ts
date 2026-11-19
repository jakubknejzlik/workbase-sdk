import { DatabaseSync } from 'node:sqlite'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, link } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { durableAtomic, json, type Store } from './storage.ts'
import { noLink } from './paths.ts'
import { hash } from './planning.ts'
import { byteHash } from './byte-digest.ts'
import { initializationDependencies } from './initialization-plan.ts'
import { parseRuntimeSource } from './composition/runtime-source.ts'
import { replayEngine, snapshot } from './offline.ts'
import { replayInstance, readInstanceMeta } from './migration-replay.ts'
import { fail } from './schemas.ts'

const identity = z.strictObject({ dev: z.string().regex(/^(0|[1-9][0-9]*)$/), ino: z.string().regex(/^(0|[1-9][0-9]*)$/) })
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const receiptSchema = z.strictObject({
  version: z.literal(1), instance: z.string(), instanceId: z.uuid(), targetId: z.uuid(),
  root: z.string(), rootIdentity: identity, planHash: digest,
  fingerprint: digest, dependencyDigest: digest.optional(),
  state: z.enum(['preparing', 'ready', 'active']),
  stageId: z.uuid().optional(), file: identity.extend({ sha256: digest }).optional(), schemaHash: digest.optional(),
}).refine(record => record.state === 'preparing' ? !record.file && !record.schemaHash && !record.stageId : !!record.file && !!record.schemaHash && !!record.stageId)
type Receipt = z.infer<typeof receiptSchema>
const directory = (root: string) => join(root, '.local', 'mcp-target')
const receiptPath = (root: string) => join(directory(root), 'receipt.json')
const targetPath = (root: string, receipt: Receipt) => join(directory(root), `${receipt.targetId}.sqlite`)
const same = (a: { dev: string; ino: string }, b: { dev: string; ino: string }) => a.dev === b.dev && a.ino === b.ino
async function statIdentity(path: string) {
  await noLink(path)
  const stat = await lstat(path, { bigint: true })
  return { dev: String(stat.dev), ino: String(stat.ino) }
}
async function sync(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}
async function readReceipt(root: string, instance: string): Promise<Receipt | undefined> {
  for (const path of [join(root, '.local'), directory(root), receiptPath(root)]) await noLink(path, true)
  let bytes: string
  try { bytes = await readFile(receiptPath(root), 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  let record: unknown
  try { record = JSON.parse(bytes) } catch { fail('local_target_conflict', 'Invalid local target receipt; preserve it for operator review', 409) }
  const parsed = receiptSchema.safeParse(record)
  if (!parsed.success) fail('local_target_conflict', 'Invalid local target receipt; preserve it for operator review', 409)
  const receipt = parsed.data
  if (receipt.root !== resolve(root) || receipt.instance !== instance || !same(receipt.rootIdentity, await statIdentity(root))) {
    fail('local_target_conflict', 'Local target belongs to another instance/root identity', 409)
  }
  return receipt
}

/** Read-only resolution. Provenance never implies emptiness, and a pending
 * creation cannot serve as target evidence. No disposable state is consulted. */
export async function managedLocalTarget(root: string, instance: string) {
  const receipt = await readReceipt(root, instance)
  if (!receipt) return
  if (receipt.state !== 'active') fail('local_target_incomplete', 'Retry create_local_target to recover pending creation', 409)
  const path = targetPath(root, receipt)
  if (!same(await statIdentity(path), receipt.file!)) fail('local_target_conflict', 'Local target file identity changed', 409)
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    if (hash(snapshot(db, true)) !== receipt.schemaHash) fail('local_target_conflict', 'Local target schema evidence changed', 409)
  } finally { db.close() }
  return { path, instanceId: receipt.instanceId, targetId: receipt.targetId, creationPlanHash: receipt.planHash }
}

/** Called under the canonical instance lock. Creation is private until a ready
 * receipt is durable; publication uses link (no replace). Interrupted migration
 * attempts are abandoned, never replayed over a potentially populated database.
 * A ready publication is recovered only by its recorded inode AND exact bytes. */
export async function createLocalTarget(store: Store, instance: string, input: { mode: 'preview' | 'apply'; planHash?: string }) {
  return store.locked(instance, async () => {
    const root = await store.directory(instance)
    const bundle = await store.load(instance, { canonicalRuntime: true })
    if (bundle.config.baseline !== 'workbase-sdk') fail('local_target_unsupported', 'Local target creation requires an initialized V3 instance', 409)
    const dependencies = await initializationDependencies(root, parseRuntimeSource(bundle.runtimeSource!))
    const planned = new DatabaseSync(':memory:'), migrationPlan: string[] = []
    try { await replayInstance(planned, bundle.migrations, replayEngine(bundle.config, bundle.runtime), { record: sql => { migrationPlan.push(sql) } }) }
    finally { planned.close() }
    const migrationPlanHash = hash(migrationPlan)
    const planHash = hash({ version: 1, root: resolve(root), rootIdentity: await statIdentity(root), instance,
      fingerprint: bundle.fingerprint, dependencyDigest: bundle.dependencyDigest, dependencies, migrationPlanHash, migrations: bundle.migrations })
    let receipt = await readReceipt(root, instance)
    const report = { ok: true, instance, planHash, appliesToDatabase: true }
    if (input.mode === 'preview') return { ...report, mode: 'preview', status: receipt?.state ?? 'absent',
      ...(receipt ? { instanceId: receipt.instanceId, targetId: receipt.targetId, creationPlanHash: receipt.planHash } : {}),
      nextStep: { tool: 'create_local_target', arguments: { instance, mode: 'apply', planHash } } }
    if (input.planHash !== planHash) fail('stale_plan', 'Local target inputs changed; preview create_local_target again', 409)
    if (receipt?.state === 'active') return { ...report, status: 'unchanged', ...await managedLocalTarget(root, instance) }
    if (receipt && receipt.planHash !== planHash) fail('stale_plan', 'Pending local target creation is bound to different sources/dependencies; restore those inputs before recovery', 409)
    for (const path of [join(root, '.local'), directory(root)]) {
      await noLink(path, true)
      await mkdir(path, { recursive: true, mode: 0o700 })
      await noLink(path)
      await sync(path); await sync(join(path, '..'))
    }
    if (!receipt) {
      // A missing association is not permission to substitute a new target for
      // this root. Only pre-intent atomic-write remnants can precede a receipt;
      // preparing intent is durable before any SQLite attempt is created.
      const remnants = await readdir(directory(root))
      if (remnants.some(name => !/^receipt\.json\.[a-f0-9-]{36}\.tmp$/.test(name))) {
        fail('local_target_conflict', 'Local target files exist without their receipt; preserve and restore the association before retrying', 409)
      }
      receipt = { version: 1, instance, instanceId: crypto.randomUUID(), targetId: crypto.randomUUID(), root: resolve(root),
        rootIdentity: await statIdentity(root), planHash, fingerprint: bundle.fingerprint,
        ...(bundle.dependencyDigest ? { dependencyDigest: bundle.dependencyDigest } : {}), state: 'preparing' }
      await durableAtomic(receiptPath(root), json(receipt))
    }
    const target = targetPath(root, receipt)
    await noLink(target, true)
    const present = await lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (receipt.state === 'preparing') {
      if (present) fail('local_target_conflict', 'Unattested target already exists; creation never overwrites a database', 409)
      // Unique attempt names make every crash window retryable without deleting
      // or modifying an interrupted attempt or any externally substituted file.
      const stageId = crypto.randomUUID()
      const stage = join(directory(root), `${receipt.targetId}.${stageId}.pending.sqlite`)
      const handle = await open(stage, 'wx', 0o600)
      await handle.close()
      const db = new DatabaseSync(stage)
      let schemaHash: string
      const appliedPlan: string[] = []
      try {
        db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL')
        await replayInstance(db, bundle.migrations, replayEngine(bundle.config, bundle.runtime), { record: sql => { appliedPlan.push(sql) } })
        if (hash(appliedPlan) !== migrationPlanHash) fail('stale_plan', 'Migration plan changed during target creation; restore inputs and retry', 409)
        const meta = readInstanceMeta(db)
        if (meta?.revision !== bundle.config.revision) fail('revision_mismatch', 'Target migration revision differs from config', 409)
        schemaHash = hash(snapshot(db, true))
      } finally { db.close() }
      await sync(stage)
      const latest = await store.load(instance, { canonicalRuntime: true })
      if (latest.fingerprint !== bundle.fingerprint || latest.dependencyDigest !== bundle.dependencyDigest
        || hash(await initializationDependencies(root, parseRuntimeSource(latest.runtimeSource!))) !== hash(dependencies)) fail('stale_plan', 'Sources/dependencies changed during local target creation; restore inputs and retry', 409)
      receipt = { ...receipt, state: 'ready', stageId, file: { ...await statIdentity(stage), sha256: byteHash(await readFile(stage)) }, schemaHash }
      await sync(directory(root))
      await durableAtomic(receiptPath(root), json(receipt))
    }
    const ready = join(directory(root), `${receipt.targetId}.${receipt.stageId}.pending.sqlite`)
    const check = async (path: string) => {
      if (!same(await statIdentity(path), receipt!.file!) || byteHash(await readFile(path)) !== receipt!.file!.sha256) {
        fail('local_target_conflict', 'Pending target identity or contents changed; preserve for operator review', 409)
      }
    }
    if (present) await check(target)
    else { await check(ready); await link(ready, target); await sync(directory(root)) }
    await check(target)
    receipt = { ...receipt, state: 'active' }
    await durableAtomic(receiptPath(root), json(receipt))
    // Keep the ready hardlink: recovery never needs to remove an unchecked file.
    return { ...report, status: 'created', ...await managedLocalTarget(root, instance) }
  })
}
