// Test-only live-phase process ownership. Preloaded before Wrangler/Playwright
// so every detached child (including library-internal launches) is registered.
const { appendFileSync, readFileSync } = require('node:fs')
const { ChildProcess, execFileSync } = require('node:child_process')
const registry = process.env.WORKBASE_LIVE_PROCESS_REGISTRY
const GRACE_MS = 12000 // Must exceed live()'s 10000 ms inner cleanup bound.
const KILL_MS = 1000

function register(file, pid) {
  if (Number.isSafeInteger(pid) && pid > 1) appendFileSync(file, pid + '\n')
}

if (registry) {
  const originalSpawn = ChildProcess.prototype.spawn
  ChildProcess.prototype.spawn = function (options) {
    // Carry ownership even through libraries supplying their own environment.
    const pairs = options.envPairs.filter(pair => !pair.startsWith('WORKBASE_LIVE_PROCESS_REGISTRY='))
    pairs.push('WORKBASE_LIVE_PROCESS_REGISTRY=' + registry)
    const index = pairs.findIndex(pair => pair.startsWith('NODE_OPTIONS='))
    const preload = '--require=' + JSON.stringify(__filename)
    if (index < 0) pairs.push('NODE_OPTIONS=' + preload)
    else if (!pairs[index].includes(__filename)) pairs[index] += ' ' + preload
    options.envPairs = pairs
    const result = originalSpawn.call(this, options)
    // Synchronous publication precedes returning the child to its caller.
    if (options.detached) register(registry, this.pid)
    return result
  }
}

function groups(file) {
  return [...new Set(readFileSync(file, 'utf8').split('\n').map(Number).filter(pid => Number.isSafeInteger(pid) && pid > 1))]
}
function signal(file, name, sent) {
  let alive = false
  for (const pgid of groups(file)) {
    try { process.kill(-pgid, sent.has(pgid) ? 0 : name); sent.add(pgid); alive = true }
    catch (error) {
      if (error.code === 'ESRCH') continue
      // Darwin reports EPERM for a group containing only unreaped zombies.
      // During synchronous exit our own child cannot be reaped by the event
      // loop. Confirm there is no runnable member instead of hiding EPERM.
      if (process.platform === 'darwin' && error.code === 'EPERM') {
        const members = execFileSync('ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8', timeout: 1000 })
          .trim().split('\n').map(line => line.trim().split(/\s+/))
        if (!members.some(([group, state]) => Number(group) === pgid && !state.startsWith('Z'))) continue
      }
      throw error
    }
  }
  return alive
}

// Re-read on every pass: a child may publish another detached group during
// shutdown. Group liveness is independent of its original leader's exit event.
async function stopGroups(file, graceMs = GRACE_MS, killMs = KILL_MS) {
  for (const [name, bound] of [['SIGTERM', graceMs], ['SIGKILL', killMs]]) {
    const sent = new Set()
    const end = Date.now() + bound
    do {
      const alive = signal(file, name, sent)
      if (!alive) return
      await new Promise(resolve => setTimeout(resolve, 25))
    } while (Date.now() < end)
  }
}
function stopGroupsSync(file, graceMs = GRACE_MS, killMs = KILL_MS) {
  const wait = new Int32Array(new SharedArrayBuffer(4))
  for (const [name, bound] of [['SIGTERM', graceMs], ['SIGKILL', killMs]]) {
    const sent = new Set()
    const end = Date.now() + bound
    do {
      if (!signal(file, name, sent)) return
      Atomics.wait(wait, 0, 0, 25)
    } while (Date.now() < end)
  }
}

module.exports = { register, stopGroups, stopGroupsSync }
