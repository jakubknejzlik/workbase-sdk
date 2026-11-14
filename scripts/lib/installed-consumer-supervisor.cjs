// Always launched by Node, detached from the parent. Only this process signals
// its own group; no numeric PID/PGID is retained for later cleanup.
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const [resultFile, ...args] = process.argv.slice(2)
const GRACE_MS = 12000 // Must exceed live()'s 10000 ms inner cleanup bound.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => {})
let sweeping = false
let result = { code: null, signal: null }
function publish() {
  // Synchronous parent exit may already have removed its temporary directory.
  // A missing result is failure for the parent, but must never prevent cleanup.
  try { writeFileSync(resultFile, JSON.stringify(result), { mode: 0o600 }) }
  catch (error) { console.error('Installed consumer result unavailable:', error.message) }
}
function sweep() {
  if (sweeping) return
  sweeping = true
  publish()
  process.kill(0, 'SIGTERM')
  setTimeout(() => {
    // Final stage: publish the marker immediately before the group kill. An
    // external SIGKILL earlier in the sweep leaves no marker and fails the run.
    result = { ...result, final: true }
    publish()
    process.kill(0, 'SIGKILL')
  }, GRACE_MS)
}
process.stdin.on('end', sweep).on('error', sweep).resume()
try {
  const live = spawn(process.execPath, args, { detached: false, stdio: 'inherit' })
  live.on('error', error => {
    result = { code: null, signal: null, error: error.message }
    sweep()
  })
  live.on('exit', (code, signal) => {
    result = { code, signal }
    if (sweeping) publish()
    else sweep()
  })
} catch (error) {
  result = { code: null, signal: null, error: error.message }
  sweep()
}
