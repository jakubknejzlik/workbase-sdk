import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { assertPortsFree } from '../harness-ports'
import { causeChain } from './workflow-diagnostics'
export const artifactRoot = resolve(process.env.C5_ARTIFACT_DIR ?? 'test-results/c5-workflow')
export const origin = `http://127.0.0.1:${Number(process.env.C5_PORT ?? 19497)}`
export async function setupWorkflowFixture() {
  await assertPortsFree([Number(new URL(origin).port)])
  mkdirSync(artifactRoot, { recursive: true })
  const directory = mkdtempSync(resolve(artifactRoot, 'run-'))
  const persist = resolve(directory, 'state')
  const logPath = resolve(directory, 'worker.log')
  const token = randomBytes(24).toString('hex')
  const root = resolve(import.meta.dirname, '../../../..')
  const configPath = resolve(directory, 'wrangler.json')
  const childEnv = { ...process.env, TMPDIR: directory, WRANGLER_REGISTRY_PATH: resolve(directory, 'registry'),
    WRANGLER_LOG_PATH: resolve(directory, 'wrangler-logs'), CLOUDFLARE_SEND_METRICS: 'false', WRANGLER_SEND_METRICS: 'false' }
  writeFileSync(configPath, JSON.stringify({ name: 'c5-workflow-repro', main: resolve(import.meta.dirname, 'workflow-worker.ts'),
    compatibility_date: '2026-08-01', compatibility_flags: ['nodejs_compat'],
    d1_databases: [{ binding: 'DB', database_name: 'c5-workflow', database_id: '00000000-0000-0000-0000-000000000097' }],
    kv_namespaces: [{ binding: 'AUDIT_KV', id: '00000000000000000000000000000097' }],
    assets: { directory: resolve(root, 'packages/frontend-console/dist'), binding: 'ASSETS', html_handling: 'none', not_found_handling: 'none', run_worker_first: true },
    vars: { STAGE: 'local', DEV_LOCAL_IDENTITY: 'true', AUTH_BASE_URL: origin, BETTER_AUTH_SECRET: 'c5-synthetic-local-secret-at-least-32-characters', C5_CONTROL_TOKEN: token },
  }))
  const log = openSync(logPath, 'a')
  let child: ChildProcess | undefined
  const logs = () => readFileSync(logPath, 'utf8')
  const stop = async () => {
    if (child?.pid && child.exitCode === null) {
      const exited = new Promise<void>(done => child!.once('exit', () => done()))
      try { process.kill(-child.pid, 'SIGTERM') } catch {}
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([exited, new Promise<void>(done => { timer = setTimeout(() => { try { process.kill(-child!.pid!, 'SIGKILL') } catch {}; done() }, 3000) })])
      clearTimeout(timer)
    }
  }
  try {
    // Synchronous child completion includes both seed proxy disposals. Only the Worker
    // owns persisted D1 throughout the browser phase; no external live DB mutations.
    execFileSync('bun', [resolve(import.meta.dirname, 'workflow-seed.ts'), configPath, persist], { cwd: root, env: childEnv, stdio: ['ignore', log, log] })
    child = spawn('bun', ['x', '--no-install', 'wrangler', 'dev', '--local', '--config', configPath, '--persist-to', persist,
      '--ip', '127.0.0.1', '--port', new URL(origin).port, '--inspector-port', '0'], { cwd: root, detached: true, env: childEnv, stdio: ['ignore', log, log] })
    closeSync(log)
    for (let attempt = 0; attempt < 200; attempt++) {
      if (child.exitCode !== null) throw new Error(`Worker exited: ${child.exitCode}`)
      try { if ((await fetch(`${origin}/health`)).ok) return { directory, persist, logPath, token, logs, stop } } catch {}
      await new Promise(done => setTimeout(done, 100))
    }
    throw new Error('Worker health readiness timed out')
  } catch (error) {
    if (!child) closeSync(log)
    await stop()
    const diagnostics = { operation: child ? 'worker-startup' : 'fixture-seed', status: null, causes: causeChain(error), persist, workerLog: logs().slice(-16000) }
    writeFileSync(resolve(directory, 'failure.json'), JSON.stringify(diagnostics, null, 2))
    throw new Error(JSON.stringify(diagnostics), { cause: error })
  }
}
