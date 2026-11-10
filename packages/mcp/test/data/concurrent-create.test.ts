import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, test } from 'vitest'
import { startFixture, type Fixture } from './fixture.ts'

let fixture: Fixture
beforeAll(async () => { fixture = await startFixture() })
afterAll(async () => { await fixture?.close() })

test('D5 concurrent keyed creates survive the fixture SQLite writer lock', async () => {
  const client = await fixture.connect()
  const directory = join(fixture.scratch, 'state/v3/d1/miniflare-D1DatabaseObject')
  const files = readdirSync(directory).filter(file => file.endsWith('.sqlite') && file !== 'metadata.sqlite')
  assert.equal(files.length, 1)
  const locker = new DatabaseSync(join(directory, files[0]))
  let released = false
  const release = () => { if (!released) { locker.exec('ROLLBACK'); released = true } }
  // Acquire the same cross-process lock as the fixture's platform proxy before
  // sending requests. No timing guess is needed to establish contention.
  locker.exec('BEGIN IMMEDIATE')
  const timer = setTimeout(release, 1000)
  try {
    const args = { entity: 'clients', data: { name: 'Contended keyed create' }, idempotencyKey: 'contended-key' }
    const results = await Promise.all(Array.from({ length: 5 }, () => fixture.tool(client, 'create_record', args)))
    assert.ok(results.every(result => result.ok === true), JSON.stringify(results))
    assert.ok(results.every(result => result.data.id === results[0].data.id))
    assert.equal(await fixture.db.prepare('SELECT count(*) AS n FROM clients WHERE name=?').bind(args.data.name).first('n'), 1)
    assert.equal(await fixture.db.prepare('SELECT count(*) AS n FROM idempotency_keys WHERE organization_id=? AND key=?').bind(fixture.org, args.idempotencyKey).first('n'), 1)
    assert.equal(await fixture.db.prepare("SELECT count(*) AS n FROM audit_outbox WHERE json_extract(payload,'$.entity_id')=?").bind(results[0].data.id).first('n'), 1)
    assert.deepEqual(await fixture.tool(client, 'create_record', { ...args, data: { name: 'mismatch' } }), { ok: false, code: 'idempotency_payload_mismatch', status: 422 })
    process.stdout.write('D5_LOCK_COUNTS {"successfulCreates":5,"distinctIds":1,"rows":1,"receipts":1,"outboxEvents":1,"mismatches":1}\n')
  } finally {
    clearTimeout(timer)
    release()
    locker.close()
  }
})
