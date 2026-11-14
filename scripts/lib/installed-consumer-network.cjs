// Verification processes only. Unix pipes are IPC; IP connections require literals.
const net = require('node:net')
const dgram = require('node:dgram')
const { syncBuiltinESMExports } = require('node:module')
const allow = host => {
  if (!['127.0.0.1', '::1', '[::1]'].includes(host)) throw Error('Installed consumer permits loopback literals only')
}
const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0]
  if (!(typeof first === 'string' || first && typeof first === 'object' && first.path)) {
    allow(first && typeof first === 'object' ? first.host ?? first.hostname : typeof args[1] === 'string' ? args[1] : undefined)
  }
  return connect.apply(this, args)
}
const udpConnect = dgram.Socket.prototype.connect
const udpSend = dgram.Socket.prototype.send
dgram.Socket.prototype.connect = function (port, address, ...args) {
  allow(address)
  return udpConnect.call(this, port, address, ...args)
}
dgram.Socket.prototype.send = function (...args) {
  // Connected UDP has already passed connect(); unconnected overloads carry a host.
  let connected = false
  try { this.remoteAddress(); connected = true } catch { /* unconnected socket */ }
  if (!connected) allow(typeof args[1] === 'number' && typeof args[2] === 'number' ? args[4] : args[2])
  return udpSend.apply(this, args)
}
// Bun and browser automation can bypass net.Socket. Check before dispatch as well.
const fetch = globalThis.fetch
globalThis.fetch = function (input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  allow(url.hostname)
  if (!['http:', 'https:'].includes(url.protocol)) throw Error('Installed consumer permits HTTP loopback only')
  return fetch.call(this, input, init)
}
syncBuiltinESMExports()
