// Actual supervisor, directory helper, inherited launch registry and Chromium;
// only the live workload and supervisor timers are replaced for determinism.
const assert = require('node:assert/strict')
const cp = require('node:child_process')
const fs = require('node:fs')
const { syncBuiltinESMExports } = require('node:module')
const { join, resolve } = require('node:path')
const { once } = require('node:events')
const delay = ms => new Promise(r => setTimeout(r, ms))
const [mode, directory, action, kind] = process.argv.slice(2)
const record = directory && join(directory, 'state.json')
const termRecord = directory && join(directory, 'term.json')
const work = directory && join(directory, 'work')
const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { if (e.code === 'ESRCH') return false; throw e } }
async function waitFor(predicate) {
  for (let i = 0; i < 400; i++) { if (predicate()) return; await delay(20) }
  throw Error('lifecycle fixture readiness/termination timed out')
}

if (mode === 'leaf') {
  process.on('SIGTERM', () => {})
  console.log(process.pid)
  setInterval(() => {}, 1000)
} else if (mode === 'detached') {
  // execFile's internal spawn plus a fresh environment must retain ownership.
  const nested = cp.execFile(process.execPath, [__filename, 'leaf'], { detached: true, env: {} })
  nested.stdout.once('data', () => console.log(JSON.stringify([process.pid, nested.pid])))
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1000)
} else if (mode === 'live') {
  ;(async () => {
    const same = cp.spawn(process.execPath, [__filename, 'leaf'])
    await once(same.stdout, 'data')
    const detached = cp.fork(__filename, ['detached'], { detached: true, env: {}, silent: true })
    const [data] = await once(detached.stdout, 'data')
    const pids = [process.pid, same.pid, ...JSON.parse(String(data))]
    let browser, context, browserPid
    if (kind === 'chromium') {
      const original = cp.spawn
      cp.spawn = (...args) => {
        const child = original(...args)
        if (args[2]?.detached) browserPid = child.pid
        return child
      }
      const { chromium } = require('playwright')
      browser = await chromium.launch()
      context = await browser.newContext()
      assert(browserPid)
      pids.push(browserPid)
      process.kill(browserPid, 'SIGSTOP')
    }
    process.on('SIGTERM', () => {
      fs.writeFileSync(termRecord, JSON.stringify({ directoryStillExists: fs.existsSync(work) }))
      if (kind === 'late') {
        const late = cp.spawn(process.execPath, [__filename, 'leaf'], { detached: true, env: {} })
        pids.push(late.pid)
        fs.writeFileSync(record, JSON.stringify(pids))
      }
      // Match production ordering; a stopped browser cannot complete this.
      if (context) void context.close().then(() => browser.close()).catch(() => {})
    })
    fs.writeFileSync(record, JSON.stringify(pids))
    if (action === 'success' || action === 'error') process.exit(action === 'success' ? 0 : 7)
    setInterval(() => {}, 1000)
  })().catch(error => { console.error(error); process.exit(1) })
} else if (mode === 'parent') {
  const actualSpawn = cp.spawn, actualTimeout = setTimeout
  cp.spawn = (_command, _args, options) => actualSpawn('node', [__filename, 'live', directory, action, kind], options)
  syncBuiltinESMExports()
  const processes = require('../../lib/installed-consumer-processes.cjs')
  const stop = processes.stopGroups, stopSync = processes.stopGroupsSync
  processes.stopGroups = file => stop(file, 250, 250)
  processes.stopGroupsSync = file => stopSync(file, 250, 250)
  global.setTimeout = (fn, ms, ...args) => ms === 240000 && action === 'timeout'
    ? actualTimeout(async () => { await waitFor(() => fs.existsSync(record)); fn(...args) }, 10)
    : actualTimeout(fn, ms, ...args)
  ;(async () => {
    const { registerTempDir } = await import('../../lib/test-temp-dir.mjs')
    fs.mkdirSync(work); registerTempDir(work)
    const { runInstalledConsumerLive } = await import('../../lib/installed-consumer-live.ts')
    const counts = ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit'].map(name => process.listenerCount(name))
    if (action === 'exit') void waitFor(() => fs.existsSync(record)).then(() => process.exit(23))
    let failure
    try { await runInstalledConsumerLive(directory, process.env, {}, directory) } catch (error) { failure = error }
    if (action === 'timeout') assert.match(failure?.message ?? '', /Installed consumer live timed out/)
    else if (action === 'error') assert.match(failure?.message ?? '', /Installed consumer live failed \(7\)/)
    else if (failure) throw failure
    assert.deepEqual(['SIGINT', 'SIGTERM', 'SIGHUP', 'exit'].map(name => process.listenerCount(name)), counts, 'supervisor listeners leaked')
  })().catch(error => { console.error(error); process.exitCode = 1 })
} else {
  ;(async () => {
    const runtime = mode
    const args = runtime === 'node' ? ['--import', resolve('node_modules/tsx/dist/esm/index.mjs')] : []
    const parent = cp.spawn(runtime, [...args, __filename, 'parent', directory, action, kind], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WORKBASE_KEEP_TMP: '0' },
    })
    let output = '', pids = []
    parent.stdout.on('data', data => { output += data })
    parent.stderr.on('data', data => { output += data })
    const exited = once(parent, 'exit')
    const watchdog = setTimeout(() => parent.kill('SIGKILL'), 12000)
    try {
      await waitFor(() => fs.existsSync(record))
      pids = JSON.parse(fs.readFileSync(record))
      if (action.startsWith('SIG')) process.kill(-parent.pid, action)
      const [code, signal] = await exited
      pids = JSON.parse(fs.readFileSync(record))
      if (action.startsWith('SIG')) assert(signal === action || code === 128 + require('node:os').constants.signals[action], JSON.stringify({ code, signal, output }))
      else assert.equal(code, action === 'exit' ? 23 : 0, output)
      await waitFor(() => pids.every(pid => !alive(pid)))
      assert(!fs.existsSync(work), 'consumer directory remains after parent exit')
      if (action.startsWith('SIG') || action === 'timeout' || action === 'exit') {
        assert.deepEqual(JSON.parse(fs.readFileSync(termRecord)), { directoryStillExists: true }, 'directory cleanup preceded group termination')
      }
      console.log(JSON.stringify({ runtime, action, kind, survivors: pids.filter(alive), directoryRemoved: true, listenersRemoved: !action.startsWith('SIG') && action !== 'exit' }))
    } finally {
      clearTimeout(watchdog)
      for (const pid of pids) { try { process.kill(-pid, 'SIGKILL') } catch {} try { process.kill(pid, 'SIGKILL') } catch {} }
      try { process.kill(-parent.pid, 'SIGKILL') } catch {}
    }
  })().catch(error => { console.error(error); process.exitCode = 1 })
}
