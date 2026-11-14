// Exercise the actual live supervisor with a real uncooperative process tree,
// and with a child whose exit event never arrives, scaling only known deadlines.
const assert = require('node:assert/strict')
const cp = require('node:child_process')
const { EventEmitter } = require('node:events')
const { syncBuiltinESMExports } = require('node:module')
const { pathToFileURL } = require('node:url')
const { resolve } = require('node:path')
const mode = process.argv[2]
if (mode === 'grandchild') {
  process.on('SIGTERM', () => console.log('grandchild ignored SIGTERM'))
  console.log('grandchild ready ' + process.pid)
  setInterval(() => {}, 1000)
} else if (mode === 'stubborn') {
  process.on('SIGTERM', () => console.log('child ignored SIGTERM'))
  cp.spawn(process.execPath, [__filename, 'grandchild'], { stdio: ['ignore', 'inherit', 'inherit'] })
  setInterval(() => {}, 1000)
} else {
  const actualSpawn = cp.spawn, actualSetTimeout = global.setTimeout
  let child, output = '', descendant, kills = []
  cp.spawn = (_command, _args, options) => {
    if (mode === 'no-exit') {
      child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: signal => { kills.push(signal); return true } })
    } else {
      child = actualSpawn(process.execPath, [__filename, 'stubborn'], { ...options, env: { ...process.env, NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.on('data', data => { output += data; descendant = Number(output.match(/grandchild ready (\d+)/)?.[1]) })
      child.stderr.on('data', data => { output += data })
    }
    return child
  }
  syncBuiltinESMExports()
  global.setTimeout = (fn, ms, ...args) => actualSetTimeout(fn, ms === 240000 ? 300 : [5000, 1000, 10000].includes(ms) ? 100 : ms, ...args)
  ;(async () => {
    const { runInstalledConsumerLive } = await import(pathToFileURL(resolve(__dirname, '../../lib/installed-consumer-live.ts')).href)
    let settled = false, failure
    const started = Date.now()
    const run = runInstalledConsumerLive(process.cwd(), process.env, {}, process.cwd()).then(
      () => { settled = true }, error => { settled = true; failure = error })
    let watchdog
    try { await Promise.race([run, new Promise(r => { watchdog = actualSetTimeout(r, 1800) })]) }
    finally { clearTimeout(watchdog) }
    assert(settled, 'live deadline and cleanup must settle without waiting indefinitely for exit')
    assert.match(failure?.message ?? '', /Installed consumer live timed out/)
    assert(Date.now() - started < 1500)
    if (mode === 'no-exit') assert.deepEqual(kills, ['SIGTERM', 'SIGKILL'])
    else {
      assert.match(output, /child ignored SIGTERM/)
      assert.match(output, /grandchild ignored SIGTERM/)
      assert.equal(child.signalCode, 'SIGKILL')
      assert(descendant)
      // Allow the OS to reap the descendant after the group kill.
      for (let i = 0; i < 20; i++) {
        try { process.kill(descendant, 0) } catch (error) { if (error.code === 'ESRCH') { descendant = undefined; break } throw error }
        await new Promise(r => actualSetTimeout(r, 20))
      }
      assert.equal(descendant, undefined, 'live descendant survived timeout')
    }
    console.log('bounded timeout passed: ' + mode)
  })().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => {
    if (child?.pid) {
      try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }
    if (descendant) { try { process.kill(descendant, 'SIGKILL') } catch {} }
  })
}
