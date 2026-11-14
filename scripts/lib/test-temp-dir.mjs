import { rmSync } from 'node:fs'
import { constants } from 'node:os'

// Test/proof processes own only the directories explicitly registered here.
const owned = new Map()
let shutdownDeferrals = 0
function cleanupRegisteredDirs() {
  for (const directory of owned.keys()) cleanupTempDir(directory)
}
process.once('exit', cleanupRegisteredDirs)
const signalHandlers = new Map()
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  const handler = () => {
    if (shutdownDeferrals) return
    try { cleanupRegisteredDirs() }
    finally {
      // Other listeners own shutdown; leave the exit cleanup active for any new dirs.
      if (process.listenerCount(signal) === 1) {
        for (const [name, listener] of signalHandlers) process.removeListener(name, listener)
        // Re-raise for the default signal status; fall back where the platform rejects it (Windows SIGHUP).
        try { process.kill(process.pid, signal) }
        catch { process.exit(128 + constants.signals[signal]) }
      }
    }
  }
  signalHandlers.set(signal, handler)
  process.on(signal, handler)
}

// A process supervisor must finish terminating users of these directories first.
export function deferTempDirCleanup() {
  shutdownDeferrals++
  let released = false
  return () => { if (!released) { released = true; shutdownDeferrals-- } }
}

export function registerTempDir(directory) {
  owned.set(directory, process.env.WORKBASE_KEEP_TMP === '1')
  return directory
}

// Preserve failure diagnostics even when the owning process exits.
export function retainTempDir(directory) {
  owned.delete(directory)
}

export function cleanupTempDir(directory) {
  if (!owned.has(directory)) return
  const keep = owned.get(directory)
  owned.delete(directory)
  if (keep) console.log(`WORKBASE_KEEP_TMP=1: ${directory}`)
  else rmSync(directory, { recursive: true, force: true })
}
