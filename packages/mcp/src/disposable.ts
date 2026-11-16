import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { CORE_VERSION } from '@workbasehq/core/config'
import type { Bundle } from './storage.ts'
import { snapshot, replayEngine, replayLegacyMigrations } from './offline.ts'
import { replayInstance, readInstanceMeta, usesBaseline, MigrationReplayError, privateReplayMessage } from './migration-replay.ts'
import { WorkflowError, type Index } from './schemas.ts'
import { rebuildBlock, rebuildBlockMessage } from './planning.ts'
import { noLink } from './storage.ts'
import type { PluginMigrationRow } from '@workbasehq/core/kernel/migrations'

// Trusted operator setting, never accepted through MCP tool arguments.
export const stateRoot = process.env.WORKBASE_MCP_STATE_ROOT ?? '/tmp/codex/mcp-state'
export type Verification = { verified: boolean; diffs: unknown[]; directory?: string }
export type Prepared = { target: Bundle['config']; indexes: Index[]; sql: string; composition?: { statements: { sql: string; name: string }[]; ledger: PluginMigrationRow[] } }
const require = createRequire(import.meta.url)
const wrangler = () => join(dirname(require.resolve('wrangler/package.json')), 'bin', 'wrangler.js')
async function migrate(config: string, persistence: string, cwd: string, entities: readonly string[], signal?: AbortSignal) {
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
        console.error('Private Wrangler migration failure', output)
        const block = !interrupted && rebuildBlock(output, entities)
        if (block) { reject(new WorkflowError('migration_blocked', rebuildBlockMessage(block), 422)); return }
        reject(new WorkflowError('disposable_apply_failed', interrupted ? 'Local migration cancelled or exceeded 90 seconds' : 'Wrangler rejected the disposable migration', 422))
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
  const entities = [...Object.keys(prepared.target.entities), ...Object.keys(bundle.config.entities)]
  await mkdir(stateRoot, { recursive: true }); await noLink(stateRoot)
  const scratch = await mkdtemp(join(stateRoot, 'proposal-'))
  try {
    const migrations = join(scratch, 'migrations'); await mkdir(migrations)
    const number = Math.max(0, ...bundle.migrations.map(m => Number(m.name.slice(0, 4)))) + 1
    if (number > 9999) throw new WorkflowError('migration_limit', 'Migration number exceeds four digits')
    const proposal = { name: `${String(number).padStart(4, '0')}_proposal.sql`, sql: prepared.sql, syntheticRevision: prepared.target.revision }
    if (prepared.composition) {
      for (const [i, statement] of prepared.composition.statements.entries()) {
        await writeFile(join(migrations, `${String(i + 1).padStart(4, '0')}_${statement.name}.sql`), statement.sql + '\n;\n')
      }
    } else {
      // Capture domain SQL and the deployment-owned migration batches, including
      // the legacy Model B repair, then execute those exact bytes in D1.
      const db = new DatabaseSync(':memory:'), statements: { sql: string; name: string }[] = []
      try {
        const engine = replayEngine(prepared.target, bundle.runtime)
        const record: NonNullable<Parameters<typeof replayInstance>[3]>['record'] = (sql, context) => statements.push({ sql, name: (context?.migration ?? 'ledger').replace(/[^a-z0-9_]/gi, '_') })
        await replayInstance(db, [...bundle.migrations, proposal], engine, { mode: 'synthetic', record })
        if (!usesBaseline(bundle.config)) await replayLegacyMigrations(db, engine, record)
      } finally { db.close() }
      for (const [i, statement] of statements.entries()) {
        await writeFile(join(migrations, `${String(i + 1).padStart(4, '0')}_${statement.name}.sql`), statement.sql + '\n;\n')
      }
    }
    const config = join(scratch, 'wrangler.json')
    await writeFile(config, JSON.stringify({ name: 'workbase-mcp-disposable', compatibility_date: '2026-08-01',
      dev: { port: 8807, inspector_port: 0 },
      d1_databases: [{ binding: 'DB', database_name: 'mcp-disposable', database_id: '00000000-0000-0000-0000-000000008807', migrations_dir: 'migrations' }] }))
    await migrate(config, join(scratch, 'persist'), scratch, entities, signal)
    const files = await sqliteFiles(join(scratch, 'persist', 'v3', 'd1'))
    if (files.length !== 1) throw new WorkflowError('disposable_not_found', 'Expected exactly one disposable D1 database', 500)
    const db = new DatabaseSync(files[0], { readOnly: true })
    try {
      const diffs = compare(expected, snapshot(db, usesBaseline(bundle.config)))
      if (prepared.composition) {
        const ledger = db.prepare('SELECT namespace,name,position,checksum FROM _plugin_migrations ORDER BY namespace,position').all()
        if (JSON.stringify(ledger) !== JSON.stringify(prepared.composition.ledger)) diffs.push({ code: 'plugin_ledger_mismatch', expected: prepared.composition.ledger, actual: ledger })
      }
      const meta = readInstanceMeta(db)
      if (meta?.revision !== prepared.target.revision || meta?.core_version !== CORE_VERSION) diffs.push({ instance_meta: meta ?? null, expectedRevision: prepared.target.revision })
      return { verified: diffs.length === 0, diffs, ...(keep ? { directory: scratch } : {}) }
    } finally { db.close() }
  } catch (error) {
    const block = error instanceof MigrationReplayError && rebuildBlock(privateReplayMessage(error), entities)
    if (block) return { verified: false, diffs: [{ code: 'migration_blocked', message: rebuildBlockMessage(block) }], ...(keep ? { directory: scratch } : {}) }
    if (error instanceof MigrationReplayError && error.diagnostic.kind === 'generation') return { verified: false, diffs: [{ code: 'disposable_verification_failed', message: 'Could not verify the disposable schema', file: error.diagnostic.file, migration: error.diagnostic.migration }], ...(keep ? { directory: scratch } : {}) }
    if (error instanceof MigrationReplayError) return { verified: false, diffs: [{ code: error.code, message: error.message }], ...(keep ? { directory: scratch } : {}) }
    if (error instanceof WorkflowError) return { verified: false, diffs: [{ code: error.code, message: error.message }], ...(keep ? { directory: scratch } : {}) }
    console.error('Private disposable verification failure', String(error instanceof Error ? error.stack : error).slice(0, 65536))
    return { verified: false, diffs: [{ code: 'disposable_verification_failed', message: 'Could not verify the disposable schema' }], ...(keep ? { directory: scratch } : {}) }
  } finally { if (!keep) await rm(scratch, { recursive: true, force: true }) }
}
