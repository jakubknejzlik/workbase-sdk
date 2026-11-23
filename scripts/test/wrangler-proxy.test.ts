import { beforeAll, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

// A child isolates Wrangler's CLI singleton and the Cloudflare Headers shim.
let cases: Record<string, any>
beforeAll(() => {
  const stdout = execFileSync('node', [resolve('scripts/test/fixtures/wrangler-proxy-contracts.mjs')], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, CLOUDFLARE_SEND_METRICS: 'false', WRANGLER_SEND_METRICS: 'false' },
  })
  cases = JSON.parse(stdout.trim().split('\n').at(-1)!).cases
}, 65_000)
const warnings = (row: any) => row.events.filter((event: any) => event.event === 'recovery-warning')
const reports = (row: any) => row.events.filter((event: any) => event.event === 'controller-report')

it('installed ProxyWorker recovers a GET on attempt 2', () => {
  const row = cases['get-recover-2']
  expect(row).toMatchObject({ attempts: 2, status: 200, body: 'recovered' })
  expect(warnings(row)).toHaveLength(1)
  expect(reports(row)).toHaveLength(0)
})
it('installed ProxyWorker recovers a HEAD on attempt 3', () => {
  const row = cases['head-recover-3']
  expect(row).toMatchObject({ attempts: 3, status: 200, body: '' })
  expect(warnings(row)).toHaveLength(1)
  expect(reports(row)).toHaveLength(0)
})
it('installed ProxyWorker surfaces exhaustion after exactly 3 attempts', () => {
  const row = cases['get-exhaust-3']
  expect(row.attempts).toBe(3)
  expect(row.error.message).toContain('Network connection lost.')
  expect(row.status).toBeUndefined()
  expect(reports(row)).toHaveLength(1)
  expect(warnings(row)).toHaveLength(0)
})
it('installed ProxyWorker never replays a rejected body-bearing POST', () => {
  const row = cases['post-reject']
  expect(row.attempts).toBe(1)
  expect(row.events[0]).toMatchObject({ method: 'POST', body: 'non-replayable body' })
  expect(row.error.message).toContain('Network connection lost.')
  expect(reports(row)).toHaveLength(1)
  expect(warnings(row)).toHaveLength(0)
})
it('installed ProxyWorker preserves a real SDK error response without retry', () => {
  const row = cases['sdk-http500']
  expect(row).toMatchObject({ attempts: 1, sdkEntries: 1, status: 500, body: '{"error":"internal_error"}', correlationId: 'proxy-contract-500' })
  expect(reports(row)).toHaveLength(0)
  expect(warnings(row)).toHaveLength(0)
})
it('post-processing is not retried; the actual dev session survives exhausted and non-retriable reports', () => {
  const row = cases.postprocess
  expect(row).toMatchObject({ attempts: 1, error: { message: 'synthetic post-processing failure' } })
  expect(reports(row)).toHaveLength(1)
  expect(warnings(row)).toHaveLength(0)
  for (const scenario of ['get-exhaust-3', 'post-reject', 'postprocess']) {
    expect(cases[scenario].session, scenario).toEqual({ status: 200, sameUrl: true, teardowns: 0, fatalEvents: [] })
  }
})
