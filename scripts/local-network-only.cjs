// Verification processes only; loaded in Node and inherited by Wrangler children.
// Reject before DNS/connect, including HTTP clients that bypass global fetch.
const net = require('node:net')
const fs = require('node:fs')
const originalConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0]
  const host = first && typeof first === 'object' ? first.host ?? first.hostname
    : typeof first === 'number' && typeof args[1] === 'string' ? args[1] : undefined
  if (host && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    if (process.env.WORKBASE_NETWORK_GUARD_LOG) fs.appendFileSync(process.env.WORKBASE_NETWORK_GUARD_LOG, 'blocked_outbound\n', { mode: 0o600 })
    throw new Error('Verification permits loopback network connections only')
  }
  return originalConnect.apply(this, args)
}
