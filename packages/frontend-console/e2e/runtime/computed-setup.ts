import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, openSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { assertPortsFree } from '../harness-ports'
export const port = Number(process.env.W44_PORT ?? 19444)
export const origin = `http://127.0.0.1:${port}`
export default async function setup(instanceRoot?: string) {
  await assertPortsFree([port])
  const directory = mkdtempSync('/tmp/codex/w44b-runtime-')
  const configPath = resolve(directory, 'wrangler.json')
  const root = resolve(import.meta.dirname, '../../../..')
  const main = instanceRoot ? resolve(instanceRoot, 'worker.ts') : resolve(import.meta.dirname, 'computed-worker.ts')
  if (instanceRoot) writeFileSync(main, `import '@workbasehq/plugins/local-auth/better-auth-als-preseed'\nimport { createApp } from '@workbasehq/core'\nimport config from './config'\nexport default { fetch(request, env, ctx) { return createApp(config, env).fetch(request, env, ctx) } }\n`)
  writeFileSync(configPath, JSON.stringify({ name: 'w44-neutral-console', main, compatibility_date: '2026-08-01', compatibility_flags: ['nodejs_compat'],
    d1_databases: [{ binding: 'DB', database_name: 'w44-neutral', database_id: '00000000-0000-0000-0000-000000000029' }],
    kv_namespaces: [{ binding: 'AUDIT_KV', id: '00000000000000000000000000000029' }],
    assets: { directory: resolve(root, 'packages/frontend-console/dist'), binding: 'ASSETS', html_handling: 'none', not_found_handling: 'none', run_worker_first: true },
    vars: { STAGE: 'local', DEV_LOCAL_IDENTITY: 'true', AUTH_BASE_URL: origin, BETTER_AUTH_SECRET: 'w44-neutral-synthetic-local-secret-at-least-32' },
  }))
  const persist = resolve(directory, 'state')
  execFileSync('bun', [resolve(import.meta.dirname, 'computed-seed.ts'), configPath, persist, ...(instanceRoot ? [resolve(instanceRoot, 'config.ts')] : [])], { cwd: root, stdio: 'inherit' })
  const log = openSync('/tmp/codex/w44b-worker.log', 'a')
  let child: ChildProcess | undefined
  const stop = async () => {
    if (child?.pid) try { process.kill(-child.pid, 'SIGTERM') } catch {}
    if (child?.exitCode === null) await new Promise<void>(done => { child!.once('exit', () => done()); setTimeout(() => { if (child?.pid) try { process.kill(-child.pid, 'SIGKILL') } catch {}; done() }, 3000).unref() })
  }
  try {
    child = spawn('bun', ['x', '--no-install', 'wrangler', 'dev', '--local', '--config', configPath, '--persist-to', persist, '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', '0'], { cwd: root, detached: true, stdio: ['ignore', log, log], env: { ...process.env, WRANGLER_REGISTRY_PATH: resolve(directory, 'registry'), CLOUDFLARE_SEND_METRICS: 'false', WRANGLER_SEND_METRICS: 'false' } })
    for (let attempt = 0; attempt < 200; attempt++) {
      if (child.exitCode !== null) throw new Error(`Neutral Worker exited; /tmp/codex/w44b-worker.log`)
      try { if ((await fetch(`${origin}/health`)).ok) { console.log(`Neutral Worker ready: ${directory}`); return stop } } catch {}
      await new Promise(done => setTimeout(done, 100))
    }
    throw new Error(`Neutral Worker not ready; /tmp/codex/w44b-worker.log`)
  } catch (error) { await stop(); throw error }
}
