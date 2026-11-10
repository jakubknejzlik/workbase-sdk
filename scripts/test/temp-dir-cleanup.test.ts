import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { constants, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'temp-cleanup-regression-')); roots.push(root)
  for (const name of ['core', 'plugins']) {
    const directory = join(root, 'packages', name)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), '{"dependencies":{}}')
  }
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: root, TEMP: root, TMP: root, WORKBASE_KEEP_TMP: '0', WORKBASE_TMP_PROBE_ROOT: root }
  delete env.WORKBASE_MCP_STATE_ROOT
  return { root, record: join(root, 'created.json'), env }
}
type Mode = 'exit' | 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'timeout'
async function runProbe(entry: string, mode: Mode, env: NodeJS.ProcessEnv, runtime = process.execPath) {
  const child: ChildProcess = spawn(runtime, [...(runtime === 'bun' ? [] : ['--import', 'tsx']), entry], {
    env: { ...env, WORKBASE_TMP_PROBE_WAIT: mode === 'exit' ? '0' : '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = '', directory = '', timer: ReturnType<typeof setTimeout> | undefined
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  child.stderr!.on('data', bytes => { stderr += bytes })
  child.stdout!.on('data', bytes => {
    stdout += bytes
    for (const line of stdout.split('\n')) {
      if (!line.startsWith('{') || !line.endsWith('}') || directory) continue
      directory = JSON.parse(line).directory
      if (mode !== 'exit') {
        const signal = mode === 'timeout' ? 'SIGTERM' : mode
        if (mode === 'timeout') timer = setTimeout(() => child.kill(signal), 100)
        else child.kill(signal)
      }
    }
  })
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 20000)
  try {
    const result = await exited
    expect(directory, stdout + stderr).toBeTruthy()
    if (mode === 'exit') expect(result.code, stderr).toBe(env.WORKBASE_TMP_PROBE_FAIL === '1' ? 1 : 0)
    else {
      const signal = mode === 'timeout' ? 'SIGTERM' : mode
      expect(result.signal === signal || result.code === 128 + constants.signals[signal], JSON.stringify(result) + stderr).toBe(true)
    }
    return { directory, stdout }
  } finally {
    clearTimeout(timer); clearTimeout(watchdog)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}

for (const [label, entry] of [
  ['prepared consumer', 'scripts/test/fixtures/prepared-consumer-probe.mjs'],
  ['MCP state', 'scripts/test/fixtures/mcp-state-probe.mjs'],
]) {
  it.each(['exit', 'SIGTERM', 'timeout'] as const)(`removes ${label} directory after %s`, async mode => {
    const { root, env } = fixture()
    const { directory } = await runProbe(entry, mode, env)
    expect(existsSync(directory), `${directory} remains`).toBe(false)
    expect(existsSync(join(root, 'workbase-proof-consumers')), 'shared dependency cache remains').toBe(false)
  })
}
it('removes prepared consumer directory after install failure', async () => {
  const { env } = fixture()
  const { directory } = await runProbe('scripts/test/fixtures/prepared-consumer-probe.mjs', 'exit', { ...env, WORKBASE_TMP_PROBE_FAIL: '1' })
  expect(existsSync(directory), `${directory} remains`).toBe(false)
}, 25000)

for (const runtime of ['node', 'bun']) {
  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)(`lets another %s listener run and own exit under ${runtime}`, signal => {
    const { root, record, env } = fixture()
    const work = join(root, 'work'), lateWork = join(root, 'shutdown-work')
    const run = spawnSync(runtime, ['--input-type=module', '--eval', `
      import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
      import { setTimeout as delay } from 'node:timers/promises'
      import { registerTempDir } from ${JSON.stringify(pathToFileURL(resolve('scripts/lib/test-temp-dir.mjs')).href)}
      const work = ${JSON.stringify(work)}, lateWork = ${JSON.stringify(lateWork)}
      mkdirSync(work); registerTempDir(work)
      const keepAlive = setInterval(() => {}, 1000)
      let signals = 0
      try {
        await new Promise(resolve => {
          process.on(${JSON.stringify(signal)}, () => {
            if (++signals === 1) setTimeout(() => process.kill(process.pid, ${JSON.stringify(signal)}), 10)
            else resolve()
          })
          setTimeout(() => process.kill(process.pid, ${JSON.stringify(signal)}), 0)
        })
      } finally {
        mkdirSync(lateWork); registerTempDir(lateWork)
        await delay(20)
        writeFileSync(${JSON.stringify(record)}, JSON.stringify({ signals, cleanedOnSignal: !existsSync(work) }))
        clearInterval(keepAlive)
        process.exitCode = 23
      }
    `], { encoding: 'utf8', timeout: 5000, env })
    expect(run.error).toBeUndefined()
    expect(run.status, run.stderr).toBe(23)
    expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual({ signals: 2, cleanedOnSignal: true })
    expect(existsSync(work), `${work} remains`).toBe(false)
    expect(existsSync(lateWork), `${lateWork} remains`).toBe(false)
  })

  it.each(['ENOSYS', 'EINVAL'] as const)(`falls back to the signal status when re-raising SIGHUP fails with %s under ${runtime}`, code => {
    const { root, env } = fixture()
    const work = join(root, 'work')
    const run = spawnSync(runtime, ['--input-type=module', '--eval', `
      import { mkdirSync } from 'node:fs'
      import { registerTempDir } from ${JSON.stringify(pathToFileURL(resolve('scripts/lib/test-temp-dir.mjs')).href)}
      mkdirSync(${JSON.stringify(work)}); registerTempDir(${JSON.stringify(work)})
      // Windows libuv rejects SIGHUP re-raising with ENOSYS.
      process.kill = () => { throw Object.assign(new Error('kill ${code}'), { code: ${JSON.stringify(code)}, syscall: 'kill' }) }
      process.emit('SIGHUP')
    `], { encoding: 'utf8', timeout: 5000, env })
    expect(run.error).toBeUndefined()
    expect(run.status, run.stderr).toBe(128 + constants.signals.SIGHUP)
    expect(existsSync(work), `${work} remains`).toBe(false)
  })

}

for (const runtime of ['node', 'bun']) {
  it.each(['exit', 'SIGINT', 'SIGTERM', 'SIGHUP', 'timeout'] as const)(`cleans owned state after %s under ${runtime} while retaining diagnostics`, async mode => {
    const { root, env } = fixture()
    const { directory } = await runProbe('scripts/test/fixtures/helper-temp-probe.mjs', mode, env, runtime)
    expect(existsSync(directory)).toBe(false)
    expect(existsSync(join(root, 'diagnostic.log'))).toBe(true)
  })
  it.each(['exit', 'SIGTERM'] as const)(`keeps opted-in state after %s under ${runtime}`, async mode => {
    const { env } = fixture()
    const { directory, stdout } = await runProbe('scripts/test/fixtures/helper-temp-probe.mjs', mode, { ...env, WORKBASE_KEEP_TMP: '1' }, runtime)
    expect(existsSync(directory)).toBe(true)
    expect(stdout).toContain(`WORKBASE_KEEP_TMP=1: ${directory}`)
  })
  it(`allows explicit cleanup twice under ${runtime}`, async () => {
    const { env } = fixture()
    const { directory } = await runProbe('scripts/test/fixtures/helper-temp-probe.mjs', 'exit', { ...env, WORKBASE_TMP_PROBE_EXPLICIT: '1' }, runtime)
    expect(existsSync(directory)).toBe(false)
  })
}
it('leaves a caller-owned MCP state root intact', async () => {
  const { root, env } = fixture()
  const { directory } = await runProbe('scripts/test/fixtures/mcp-state-probe.mjs', 'exit', { ...env, WORKBASE_MCP_STATE_ROOT: root })
  expect(directory).toBe(root)
  expect(existsSync(root)).toBe(true)
})

it.each([
  'packages/frontend-console/e2e/runtime/setup.ts',
  'packages/frontend-console/e2e/runtime/computed-setup.ts',
  'packages/mcp/test/data/fixture.ts',
  'scripts/sdk-smoke.ts',
  'scripts/sdk-sst-smoke.ts',
  'scripts/smoke-console-package.ts',
  'scripts/smoke-mcp-template.ts',
])('removes %s state after failed setup', async entry => {
  const { root, env } = fixture()
  const { directory } = await runProbe('scripts/test/fixtures/temp-creator-probe.mjs', 'exit', {
    ...env, WORKBASE_TMP_PROBE_MODULE: entry, WORKBASE_DATA_MCP_STATE: root, WORKBASE_TMP_PROBE_FAIL: '1',
  })
  expect(existsSync(directory), `${directory} remains`).toBe(false)
}, 25000)
