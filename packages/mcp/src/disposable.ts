import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { CORE_VERSION } from '@workbasehq/core/config'
import type { Bundle } from './storage.ts'
import { snapshot } from './offline.ts'
import { WorkflowError, type Index } from './schemas.ts'
import { noLink } from './storage.ts'
import { migrationBlockReason } from './planning.ts'

// Trusted operator setting, never accepted through MCP tool arguments.
export const stateRoot = process.env.WORKBASE_MCP_STATE_ROOT ?? '/tmp/codex/mcp-state'
export type Verification = { verified: boolean; diffs: unknown[]; directory?: string }
export type Prepared = { target: Bundle['config']; indexes: Index[]; sql: string }
const require = createRequire(import.meta.url)
const wrangler = () => join(dirname(require.resolve('wrangler/package.json')), 'bin', 'wrangler.js')
async function migrate(config: string, persistence: string, cwd: string, signal?: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [wrangler(), 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persistence, '--config', config], {
      cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
        CI: 'true', CLOUDFLARE_SEND_METRICS: 'false', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(cwd, 'wrangler.log') },
    })
    let output = ''
    const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-65536) }
    child.stdout.on('data', capture); child.stderr.on('data', capture)
    let stopped = false
    let escalation: ReturnType<typeof setTimeout> | undefined
    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid) { try { process.kill(-child.pid, signal) } catch { /* already exited */ } }
    }
    const stop = () => {
      if (stopped) return
      stopped = true
      killGroup('SIGTERM')
      escalation = setTimeout(() => killGroup('SIGKILL'), 300)
    }
    const timer = setTimeout(stop, 90000)
    signal?.addEventListener('abort', stop, { once: true })
    if (signal?.aborted) stop()
    const cleanup = () => {
      clearTimeout(timer); clearTimeout(escalation); signal?.removeEventListener('abort', stop)
      // Also reap descendants if Wrangler itself exited first.
      killGroup('SIGKILL')
    }
    child.on('error', e => { cleanup(); reject(e) })
    child.on('close', code => {
      const interrupted = stopped
      cleanup()
      if (code === 0 && !interrupted) resolve()
      else {
        const reason = !interrupted && migrationBlockReason(output)
        reject(new WorkflowError(reason ? 'migration_blocked' : 'disposable_apply_failed', reason || (interrupted ? 'Local migration cancelled or exceeded 90 seconds' : 'Wrangler rejected the disposable migration'), 422))
      }
    })
  })
}
async function sqliteFiles(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    await noLink(path)
    if (entry.isDirectory()) found.push(...await sqliteFiles(path))
    else if (/^[a-f0-9]{64}\.sqlite$/.test(entry.name)) found.push(path)
  }
  return found
}
export function compare(expected: ReturnType<typeof snapshot>, actual: ReturnType<typeof snapshot>) {
  const diffs: unknown[] = []
  for (const name of new Set([...expected.map(r => r.name), ...actual.map(r => r.name)])) {
    const a = expected.find(r => r.name === name), b = actual.find(r => r.name === name)
    if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push({ name, expected: a ?? null, actual: b ?? null })
  }
  return diffs
}
export async function applyDisposable(bundle: Bundle, prepared: Prepared, expected: ReturnType<typeof snapshot>, keep: boolean, signal?: AbortSignal): Promise<Verification> {
  await mkdir(stateRoot, { recursive: true }); await noLink(stateRoot)
  const scratch = await mkdtemp(join(stateRoot, 'proposal-'))
  try {
    const migrations = join(scratch, 'migrations'); await mkdir(migrations)
    for (const m of bundle.migrations) await writeFile(join(migrations, m.name), m.sql)
    const number = Math.max(0, ...bundle.migrations.map(m => Number(m.name.slice(0, 4)))) + 1
    if (number > 9999) throw new WorkflowError('migration_limit', 'Migration number exceeds four digits')
    await writeFile(join(migrations, `${String(number).padStart(4, '0')}_proposal.sql`), prepared.sql)
    const config = join(scratch, 'wrangler.json')
    await writeFile(config, JSON.stringify({ name: 'workbase-mcp-disposable', compatibility_date: '2026-08-01',
      dev: { port: 8807, inspector_port: 0 },
      d1_databases: [{ binding: 'DB', database_name: 'mcp-disposable', database_id: '00000000-0000-0000-0000-000000008807', migrations_dir: 'migrations' }] }))
    await migrate(config, join(scratch, 'persist'), scratch, signal)
    const files = await sqliteFiles(join(scratch, 'persist', 'v3', 'd1'))
    if (files.length !== 1) throw new WorkflowError('disposable_not_found', 'Expected exactly one disposable D1 database', 500)
    const db = new DatabaseSync(files[0], { readOnly: true })
    try {
      const diffs = compare(expected, snapshot(db))
      const meta = db.prepare('SELECT revision,core_version FROM instance_meta ORDER BY revision DESC LIMIT 1').get()
      if (meta?.revision !== prepared.target.revision || meta?.core_version !== CORE_VERSION) diffs.push({ instance_meta: meta ?? null, expectedRevision: prepared.target.revision })
      return { verified: diffs.length === 0, diffs, ...(keep ? { directory: scratch } : {}) }
    } finally { db.close() }
  } catch (error) {
    if (error instanceof WorkflowError) return { verified: false, diffs: [{ code: error.code, message: error.message }], ...(keep ? { directory: scratch } : {}) }
    return { verified: false, diffs: [{ code: 'disposable_verification_failed', message: 'Could not verify the disposable schema' }], ...(keep ? { directory: scratch } : {}) }
  } finally { if (!keep) await rm(scratch, { recursive: true, force: true }) }
}
