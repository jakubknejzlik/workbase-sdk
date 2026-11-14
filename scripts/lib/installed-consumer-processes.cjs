// Test-only preload: keep Node-launched descendants in the supervisor's group,
// even when a library requests a detached process or supplies a fresh env.
const { ChildProcess } = require('node:child_process')
const originalSpawn = ChildProcess.prototype.spawn
ChildProcess.prototype.spawn = function (options) {
  // Bun does not expose Node's normalized envPairs; leave that API unchanged.
  // Production live workloads and their Wrangler children always run in Node.
  if (!options.envPairs) return originalSpawn.call(this, options)
  options.detached = false
  const pairs = [...options.envPairs]
  const index = pairs.findIndex(pair => pair.startsWith('NODE_OPTIONS='))
  const preload = '--require=' + JSON.stringify(__filename)
  if (index < 0) pairs.push('NODE_OPTIONS=' + preload)
  else if (!pairs[index].includes(__filename)) pairs[index] += ' ' + preload
  options.envPairs = pairs
  return originalSpawn.call(this, options)
}
