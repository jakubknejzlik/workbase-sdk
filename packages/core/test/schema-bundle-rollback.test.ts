import { env } from 'cloudflare:workers'
import { reset } from 'cloudflare:test'
import { beforeEach, expect, it } from 'vitest'
import { migrateD1, type D1Query } from '../src/infra/d1-migrations'
import { revisionSQL } from '../src/migrations/schema'
import { manualEvidence, renderBundle } from '../src/migrations/schema-bundle'
import { sha256 } from '../src/crypto'

beforeEach(reset)
it('real local D1 failing post-data rolls back pre/generated tables and both receipts', async () => {
  await env.DB.exec('CREATE TABLE instance_meta (revision INTEGER PRIMARY KEY, core_version TEXT NOT NULL, applied_at TEXT NOT NULL);')
  const bundle = { revision: 1, parent: null, manual: 'unconfirmed', pre: 'CREATE TABLE pre_probe (id TEXT);\n', generated: 'CREATE TABLE generated_probe (id TEXT);\n', post: 'INSERT INTO missing_post_table VALUES (1);\n' }
  bundle.manual = await manualEvidence(bundle)
  const sql = renderBundle(bundle)
  // The D1 API executes a multi-statement prepared query atomically. Keep the
  // entire bundle and receipts in the same call, as the HTTP adapter does.
  const query: D1Query = async statement => [{ success: true, results: (await env.DB.prepare(statement).all()).results }]
  await expect(migrateD1(query, [{ filename: '0001_r1.sql', sql, checksum: await sha256(sql) }], () => revisionSQL(1))).rejects.toThrow('missing_post_table')
  expect((await env.DB.prepare("SELECT name FROM sqlite_schema WHERE name IN ('pre_probe','generated_probe')").all()).results).toEqual([])
  expect((await env.DB.prepare('SELECT * FROM _migrations').all()).results).toEqual([])
  expect((await env.DB.prepare('SELECT * FROM instance_meta').all()).results).toEqual([])
})
