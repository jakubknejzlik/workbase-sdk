import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { startFixture, type Fixture } from './data/fixture.ts'
import { withD1Retry } from './data/d1-retry.ts'

function fakeDatabase() {
  const statement = {
    bind: vi.fn(function () { return statement }),
    run: vi.fn(), all: vi.fn(), first: vi.fn(), raw: vi.fn(),
  }
  const database = { prepare: vi.fn(() => statement), batch: vi.fn(), exec: vi.fn() }
  return { statement, database, db: database as unknown as D1Database }
}

afterEach(() => vi.useRealTimers())

describe('test-side D1 retry', () => {
  it.each(['run', 'all', 'first', 'raw'] as const)('%s returns the result after two BUSY failures', async method => {
    vi.useFakeTimers()
    const { statement, db } = fakeDatabase()
    const result = { results: [{ id: 'row' }] }
    statement[method].mockRejectedValueOnce(new Error('database is locked: SQLITE_BUSY'))
      .mockRejectedValueOnce(new Error('D1_ERROR: Failed to parse body as JSON, got: Error: internal error; reference = test'))
      .mockResolvedValueOnce(result)
    const prepared = withD1Retry(db).prepare('SELECT ?').bind('row')
    const pending = method === 'first' ? prepared.first('id') : method === 'raw' ? prepared.raw({ columnNames: true }) : prepared[method]()
    await vi.advanceTimersByTimeAsync(25)
    expect(statement[method]).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(50)
    expect(await pending).toBe(result)
    expect(statement[method]).toHaveBeenCalledTimes(3)
    expect(statement.bind).toHaveBeenCalledWith('row')
    expect(statement[method]).toHaveBeenLastCalledWith(...(method === 'first' ? ['id'] : method === 'raw' ? [{ columnNames: true }] : []))
  })

  it.each(['D1_ERROR: data_mcp_test_failure: SQLITE_CONSTRAINT', 'D1_ERROR: no such table: missing', 'internal error'])('immediately rethrows %s', async message => {
    vi.useFakeTimers()
    const { statement, db } = fakeDatabase()
    const error = new Error(message)
    statement.run.mockRejectedValue(error)
    await expect(withD1Retry(db).prepare('INSERT INTO clients VALUES (?)').run()).rejects.toBe(error)
    expect(statement.run).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rethrows the original BUSY error after the ten-second budget', async () => {
    vi.useFakeTimers()
    const { statement, db } = fakeDatabase()
    const original = new Error('SQLITE_BUSY_SNAPSHOT')
    statement.all.mockRejectedValueOnce(original).mockRejectedValue(new Error('database is locked'))
    const pending = expect(withD1Retry(db).prepare('SELECT * FROM clients').all()).rejects.toBe(original)
    await vi.advanceTimersByTimeAsync(10000)
    await pending
    expect(statement.all).toHaveBeenCalledTimes(10)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retries the whole batch using the underlying bound statements', async () => {
    vi.useFakeTimers()
    const { statement, database, db } = fakeDatabase()
    const result = [{ results: [{ id: 'row' }] }]
    database.batch.mockImplementationOnce(function (this: typeof database, statements) {
      expect(this).toBe(database)
      expect(statements).toEqual([statement])
      expect(statements[0]).toBe(statement)
      return Promise.reject(new Error('SQLITE_BUSY'))
    }).mockResolvedValueOnce(result)
    const wrapped = withD1Retry(db)
    const pending = wrapped.batch([wrapped.prepare('SELECT ?').bind('row')])
    await vi.advanceTimersByTimeAsync(25)
    expect(await pending).toBe(result)
    expect(database.batch).toHaveBeenCalledTimes(2)
    expect(database.batch).toHaveBeenLastCalledWith([statement])
  })

  it('retries BUSY causes and preserves the receiver and arguments for exec', async () => {
    vi.useFakeTimers()
    const { database, db } = fakeDatabase()
    database.exec.mockRejectedValueOnce(new Error('D1_ERROR', { cause: new Error('database is locked') }))
      .mockImplementation(function (this: typeof database, sql) { expect(this).toBe(database); return sql })
    const pending = withD1Retry(db).exec('SELECT 1')
    await vi.advanceTimersByTimeAsync(25)
    expect(await pending).toBe('SELECT 1')
    expect(database.exec).toHaveBeenCalledTimes(2)
  })
})

// The Worker owns the write transaction; the proxy's snapshot must tolerate it.
describe('cross-process D1 snapshot', () => {
  let fixture: Fixture
  beforeAll(async () => { fixture = await startFixture() })
  afterAll(async () => { await fixture?.close() })

  it('reads all snapshot tables while a Worker request holds a write lock', async () => {
    await fixture.db.prepare("CREATE TRIGGER data_mcp_slow_write BEFORE INSERT ON clients WHEN NEW.name='Snapshot lock probe' BEGIN SELECT sum(x) FROM (WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<5000000) SELECT x FROM n); END").run()
    const request = fixture.call('/api/clients', 'POST', { name: 'Snapshot lock probe' }, fixture.dispatcher.token)
    try {
      // The trigger keeps the write lock for hundreds of milliseconds after auth.
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(await fixture.snapshot()).toHaveLength(11)
      const response = await request
      expect(response.status).toBe(201)
      await response.arrayBuffer()
    } finally {
      await request
      await fixture.db.prepare('DROP TRIGGER data_mcp_slow_write').run()
    }
  })
})
