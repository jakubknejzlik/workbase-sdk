import { env, reset } from 'cloudflare:test'
import { beforeEach } from 'vitest'
import { baselineContract } from './fixtures/sdk-baseline/contract'
import { eraContract } from './fixtures/config-era/contract'
import { splitStatements } from '../src/kernel/migrations'
import type { D1Query } from '../src/infra/d1-migrations'

beforeEach(reset)
function database(db = env.DB) {
  const calls: string[] = []
  const query: D1Query = async sql => {
    calls.push(sql)
    return db.batch(splitStatements(sql).map(statement => db.prepare(statement)))
  }
  return { db, query, calls }
}
baselineContract(database)
eraContract(database, () => database(env.FRESH_DB))
