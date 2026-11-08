import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { setup, insertDomain, request, json, runtime } from '@workbasehq/test-support/helpers'
import { createApp } from '../src/app'
import sample from './fixtures/sample/config'
import { counterCommands } from './fixtures/sample/commands'
let app: Awaited<ReturnType<typeof setup>>
beforeEach(async () => {
  await setup(); app = createApp(sample, runtime(), { commands: counterCommands }); await insertDomain(); await insertDomain('org-b')
  await env.DB.exec('UPDATE slots SET capacity=5')
})
const create = (key: string, slotId = 'slot-org-a', clientId = 'client-org-a', org = 'org-a') => request(app, '/commands/bookings/create', 'POST', { slotId, clientId, idempotencyKey: key }, org === 'org-a' ? 'dispatcher-a' : 'owner-b', org)
async function snapshot() {
  const tables = ['bookings', 'slots', 'audit_outbox', 'idempotency_keys', 'security_log']
  return Promise.all(tables.map(table => env.DB.prepare(`SELECT * FROM ${table} ORDER BY 1`).all().then(r => r.results)))
}
async function counts() {
  return Promise.all(['bookings', 'audit_outbox', 'idempotency_keys'].map(t => env.DB.prepare(`SELECT count(*) AS n FROM ${t}`).first('n')))
}
it('B1 ten identical creates consume one of five seats with byte-identical 201 bodies', async () => {
  const responses = await Promise.all(Array.from({ length: 10 }, () => create('ten')))
  expect(responses.map(r => r.status)).toEqual(Array(10).fill(201))
  expect(new Set(await Promise.all(responses.map(r => r.text()))).size).toBe(1)
  expect(await counts()).toEqual([1, 1, 1])
  expect(await env.DB.prepare("SELECT booked FROM slots WHERE id='slot-org-a'").first('booked')).toBe(1)
})
it('B2 lost create response replays without changing any row or seat', async () => {
  const first = await create('lost'); expect(first.status).toBe(201)
  const bytes = await first.text(); const before = await snapshot()
  const retry = await create('lost'); expect(retry.status).toBe(201); expect(await retry.text()).toBe(bytes)
  expect(await snapshot()).toEqual(before); expect(await counts()).toEqual([1, 1, 1])
})
it.each(['slotId', 'clientId'] as const)('B3 same create key with different %s returns 422 without data changes', async field => {
  await create('payload')
  const before = await snapshot()
  const input = { slotId: 'slot-org-a', clientId: 'client-org-a', idempotencyKey: 'payload', [field]: 'different' }
  const retry = await request(app, '/commands/bookings/create', 'POST', input)
  expect(retry.status).toBe(422); expect(await json(retry)).toEqual({ error: 'idempotency_payload_mismatch' })
  expect(await snapshot()).toEqual(before)
})
it('B4 same key in two organizations never discloses or replays the other response', async () => {
  const a = await create('shared'); const original = await a.text()
  // Even an identical payload must not replay A's response to B.
  const foreign = await create('shared', 'slot-org-a', 'client-org-a', 'org-b')
  expect(foreign.status).toBe(404); expect(await foreign.text()).not.toBe(original)
  const b = await create('shared', 'slot-org-b', 'client-org-b', 'org-b')
  expect(b.status).toBe(201); const other = await b.text(); expect(other).not.toBe(original)
  expect(JSON.parse(other).organization_id).toBe('org-b')
  const replay = await create('shared', 'slot-org-b', 'client-org-b', 'org-b')
  expect(replay.status).toBe(201); expect(await replay.text()).toBe(other)
  expect(await counts()).toEqual([2, 2, 2])
})
it('B5 capacity rejection stores no key so the same attempt succeeds after cancellation', async () => {
  await env.DB.exec("UPDATE slots SET capacity=1 WHERE id='slot-org-a'")
  const occupant = await json(await create('occupant'))
  const rejected = await create('retry-after-full')
  expect(rejected.status).toBe(409); expect(await json(rejected)).toEqual({ error: 'capacity_exceeded' })
  expect(await counts()).toEqual([1, 1, 1])
  expect(await env.DB.prepare("SELECT count(*) AS n FROM idempotency_keys WHERE key='retry-after-full'").first('n')).toBe(0)
  expect((await request(app, '/commands/bookings/cancel', 'POST', { bookingId: occupant.id })).status).toBe(200)
  expect((await create('retry-after-full')).status).toBe(201)
  expect(await counts()).toEqual([2, 3, 2])
  expect(await env.DB.prepare("SELECT booked FROM slots WHERE id='slot-org-a'").first('booked')).toBe(1)
})
for (const command of ['cancel', 'move']) {
  async function fixture() {
    const booking = await json(await create(`fixture-${command}`))
    const target = await json(await request(app, '/api/slots', 'POST', { job_id: 'job-org-a', starts_at: new Date().toISOString(), capacity: 5 }))
    const input = { bookingId: booking.id, ...(command === 'move' ? { toSlotId: target.id } : {}), idempotencyKey: `${command}-key` }
    const call = (body = input) => request(app, `/commands/bookings/${command}`, 'POST', body, 'dispatcher-a')
    return { booking, target, input, call }
  }
  it(`B6 ${command}: ten identical concurrent requests emit one event and consume no extra seats`, async () => {
    const { call, target } = await fixture()
    const before = await counts()
    const responses = await Promise.all(Array.from({ length: 10 }, () => call()))
    expect(responses.map(r => r.status)).toEqual(Array(10).fill(200))
    expect(new Set(await Promise.all(responses.map(r => r.text()))).size).toBe(1)
    expect(await counts()).toEqual([before[0], Number(before[1]) + 1, Number(before[2]) + 1])
    const slots = await env.DB.prepare('SELECT id,booked FROM slots').all<any>()
    for (const slot of slots.results) expect(slot.booked).toBe(command === 'move' && slot.id === target.id ? 1 : 0)
  })
  it(`B6 ${command}: lost response retry changes no rows`, async () => {
    const { call } = await fixture()
    const first = await call(); expect(first.status).toBe(200); const bytes = await first.text()
    const before = await snapshot(); const retry = await call()
    expect(retry.status).toBe(200); expect(await retry.text()).toBe(bytes)
    expect(await snapshot()).toEqual(before)
  })
  it(`B6 ${command}: same key remains independent across organizations`, async () => {
    const { input, call } = await fixture()
    const a = await call(); expect(a.status).toBe(200); const aBytes = await a.text()
    const foreign = await request(app, `/commands/bookings/${command}`, 'POST', input, 'owner-b', 'org-b')
    expect(foreign.status).toBe(404); expect(await foreign.text()).not.toBe(aBytes)
    const bBooking = await json(await create(`b-fixture-${command}`, 'slot-org-b', 'client-org-b', 'org-b'))
    const bTarget = await json(await request(app, '/api/slots', 'POST', { job_id: 'job-org-b', starts_at: new Date().toISOString(), capacity: 5 }, 'owner-b', 'org-b'))
    const bInput = { ...input, bookingId: bBooking.id, ...(command === 'move' ? { toSlotId: bTarget.id } : {}) }
    const b = await request(app, `/commands/bookings/${command}`, 'POST', bInput, 'owner-b', 'org-b')
    expect(b.status).toBe(200); const bBytes = await b.text()
    expect(JSON.parse(bBytes).organization_id).toBe('org-b'); expect(bBytes).not.toBe(aBytes)
    const replay = await request(app, `/commands/bookings/${command}`, 'POST', bInput, 'owner-b', 'org-b')
    expect(replay.status).toBe(200); expect(await replay.text()).toBe(bBytes)
    expect(await env.DB.prepare('SELECT count(*) AS n FROM idempotency_keys WHERE key=?').bind(input.idempotencyKey).first('n')).toBe(2)
  })
  it(`B6 ${command}: rejected attempts never store keys or success events`, async () => {
    const { call, input, target } = await fixture()
    if (command === 'cancel') await call()
    else {
      await env.DB.prepare('UPDATE slots SET capacity=1 WHERE id=?').bind(target.id).run()
      await create('fill-move-target', target.id)
    }
    const before = await counts()
    const rejected = { ...input, idempotencyKey: `rejected-${command}` }
    for (let i = 0; i < 2; i++) expect((await call(rejected)).status).toBe(409)
    expect(await counts()).toEqual(before)
    expect(await env.DB.prepare('SELECT count(*) AS n FROM idempotency_keys WHERE key=?').bind(rejected.idempotencyKey).first('n')).toBe(0)
    if (command === 'move') {
      const occupant = await env.DB.prepare("SELECT id FROM bookings WHERE slot_id=? AND status='confirmed'").bind(target.id).first<string>('id')
      await request(app, '/commands/bookings/cancel', 'POST', { bookingId: occupant })
      expect((await call(rejected)).status).toBe(200)
      expect(await env.DB.prepare('SELECT booked FROM slots WHERE id=?').bind(target.id).first('booked')).toBe(1)
    }
  })
  it(`B6 ${command}: mismatched payload returns 422 without data changes`, async () => {
    const { call, input } = await fixture(); await call()
    const before = await snapshot()
    const retry = await call({ ...input, bookingId: 'different' })
    expect(retry.status).toBe(422); expect(await json(retry)).toEqual({ error: 'idempotency_payload_mismatch' })
    expect(await snapshot()).toEqual(before)
  })
}
