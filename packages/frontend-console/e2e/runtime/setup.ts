import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, openSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { assertPortsFree } from '../harness-ports'
export const port = Number(process.env.W29_PORT ?? 19429)
export const origin = `http://127.0.0.1:${port}`
export default async function setup() {
  await assertPortsFree([port])
  const directory = mkdtempSync('/tmp/codex/w29-runtime-')
  const configPath = resolve(directory, 'wrangler.json')
  const root = resolve(import.meta.dirname, '../../../..')
  writeFileSync(configPath, JSON.stringify({ name: 'w29-neutral-console', main: resolve(import.meta.dirname, 'worker.ts'), compatibility_date: '2026-08-01', compatibility_flags: ['nodejs_compat'],
    d1_databases: [{ binding: 'DB', database_name: 'w29-neutral', database_id: '00000000-0000-0000-0000-000000000029' }],
    kv_namespaces: [{ binding: 'AUDIT_KV', id: '00000000000000000000000000000029' }],
    assets: { directory: resolve(root, 'packages/frontend-console/dist'), binding: 'ASSETS', html_handling: 'none', not_found_handling: 'none', run_worker_first: true },
    vars: { STAGE: 'local', DEV_LOCAL_IDENTITY: 'true', AUTH_BASE_URL: origin, BETTER_AUTH_SECRET: 'w29-neutral-synthetic-local-secret-at-least-32' },
  }))
  const persist = resolve(directory, 'state')
  execFileSync('bun', [resolve(import.meta.dirname, 'seed.ts'), configPath, persist], { cwd: root, stdio: 'inherit' })
  const log = openSync(resolve(directory, 'worker.log'), 'a')
  let child: ChildProcess | undefined
  const stop = async () => {
    if (child?.pid) try { process.kill(-child.pid, 'SIGTERM') } catch {}
    if (child?.exitCode === null) await new Promise<void>(done => { child!.once('exit', () => done()); setTimeout(() => { if (child?.pid) try { process.kill(-child.pid, 'SIGKILL') } catch {}; done() }, 3000).unref() })
  }
  try {
    child = spawn('bun', ['x', '--no-install', 'wrangler', 'dev', '--local', '--config', configPath, '--persist-to', persist, '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', '0'], { cwd: root, detached: true, stdio: ['ignore', log, log], env: { ...process.env, WRANGLER_REGISTRY_PATH: resolve(directory, 'registry'), CLOUDFLARE_SEND_METRICS: 'false', WRANGLER_SEND_METRICS: 'false' } })
    for (let attempt = 0; attempt < 200; attempt++) {
      if (child.exitCode !== null) throw new Error(`Neutral Worker exited; ${directory}/worker.log`)
      try { if ((await fetch(`${origin}/health`)).ok) { console.log(`Neutral Worker ready: ${directory}`); return stop } } catch {}
      await new Promise(done => setTimeout(done, 100))
    }
    throw new Error(`Neutral Worker not ready; ${directory}/worker.log`)
  } catch (error) { await stop(); throw error }
}
