// Evaluate the installed, unmodified ProxyWorker with only its fetch boundary controlled.
// Forward its real reports through a running installed ProxyController/DevEnv, then
// request the same dev session again. No production code or installed files are edited.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const { unstable_startWorker } = require('wrangler')
const installed = dirname(require.resolve('wrangler/package.json'))
const version = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version
const bytes = readFileSync(join(installed, 'wrangler-dist/ProxyWorker.js'), 'utf8')
assert.ok(bytes.includes('var ProxyWorker = class'))
const source = bytes.replace('import assert from "node:assert";', '').replace(/export \{[\s\S]*$/, '')
// Cloudflare extends Headers; this child-only shim also covers Response.headers.
Headers.prototype.getAll = function (name) {
  return name.toLowerCase() === 'set-cookie' ? this.getSetCookie() : [this.get(name)].filter(Boolean)
}
const output = process.env.WRANGLER_PROXY_OUTPUT
const result = { version, proxyWorkerSha256: createHash('sha256').update(bytes).digest('hex'), cases: {} }
const worker = await unstable_startWorker({
  name: 'proxy-contract',
  entrypoint: fileURLToPath(new URL('./wrangler-proxy-worker.ts', import.meta.url)),
  compatibilityDate: '2026-08-01', compatibilityFlags: ['nodejs_compat'],
  bindings: { DB: { type: 'd1', database_name: 'proxy-contract', database_id: '00000000-0000-0000-0000-000000000234' } },
  dev: { watch: false, remote: false, server: { hostname: '127.0.0.1', port: 0 }, inspector: false, persist: false, logLevel: 'none' },
})
const fatalEvents = []
let teardowns = 0
worker.raw.on('error', event => fatalEvents.push({ reason: event.reason, message: event.cause?.message }))
worker.raw.on('teardown', () => { teardowns++ })
try {
  await worker.ready
  const sessionUrl = String(await worker.url)
  for (const scenario of ['get-recover-2', 'head-recover-3', 'get-exhaust-3', 'post-reject', 'sdk-http500', 'postprocess']) {
    const events = []
    let attempts = 0
    const method = scenario.startsWith('head') ? 'HEAD' : scenario === 'post-reject' ? 'POST' : 'GET'
    const beforeErrors = fatalEvents.length
    const beforeEntries = await (await worker.fetch('http://localhost/__contract/entries')).json()
    const context = vm.createContext({
      assert, Request, Response, Headers, URL, setTimeout, clearTimeout,
      console: { warn: message => events.push({ event: 'recovery-warning', message }) },
      fetch: async (_url, request) => {
        attempts++
        events.push({ event: 'upstream-attempt', attempt: attempts, method: request.method, body: request.method === 'POST' ? await request.text() : null })
        if ((scenario === 'get-recover-2' && attempts === 1) || (scenario === 'head-recover-3' && attempts < 3) || scenario === 'get-exhaust-3' || scenario === 'post-reject') throw new Error('Network connection lost.')
        if (scenario === 'postprocess') return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode('synthetic response'))
          setTimeout(() => controller.error(new Error('synthetic post-processing failure')), 10)
        } }), { status: 400 })
        if (scenario === 'sdk-http500') return worker.fetch('http://localhost/__contract/sdk500', { headers: { 'x-correlation-id': 'proxy-contract-500' } })
        return new Response(method === 'HEAD' ? null : 'recovered', { status: 200 })
      },
    })
    vm.runInContext(source + '\nglobalThis.InstalledProxyWorker = ProxyWorker;', context)
    const proxy = new context.InstalledProxyWorker({}, {
      PROXY_CONTROLLER_AUTH_SECRET: 'synthetic-controller-secret',
      PROXY_CONTROLLER: { fetch: async (_url, options) => {
        const report = JSON.parse(options.body)
        events.push({ event: 'controller-report', report })
        worker.raw.proxy.onProxyWorkerMessage(report)
        return new Response(null, { status: 204 })
      } },
    })
    proxy.proxyData = { userWorkerUrl: { protocol: 'http:', hostname: '127.0.0.1', port: '23456' } }
    let status, body, correlationId, error
    try {
      const response = await proxy.fetch(new Request('http://localhost/__contract/' + scenario, { method, ...(method === 'POST' ? { body: 'non-replayable body' } : {}) }))
      status = response.status
      body = await response.text()
      correlationId = response.headers.get('x-correlation-id')
    } catch (caught) { error = { name: caught.name, message: caught.message } }
    const afterEntries = await (await worker.fetch('http://localhost/__contract/entries')).json()
    const alive = await worker.fetch('http://localhost/console-info')
    result.cases[scenario] = {
      attempts, status, body, correlationId, error, events, sdkEntries: afterEntries.entries - beforeEntries.entries,
      session: { status: alive.status, sameUrl: String(await worker.url) === sessionUrl, teardowns, fatalEvents: fatalEvents.slice(beforeErrors) },
    }
  }
} finally {
  await worker.dispose()
  if (output) { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(result, null, 2) + '\n') }
}
console.log(JSON.stringify(result))
