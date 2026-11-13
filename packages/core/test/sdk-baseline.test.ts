import { env, reset } from 'cloudflare:test'
import { beforeEach } from 'vitest'
import { baselineContract } from './fixtures/sdk-baseline/contract'
import { splitStatements } from '../src/kernel/migrations'
import type { D1Query } from '../src/infra/d1-migrations'

beforeEach(reset)
baselineContract(() => {
  const calls: string[] = []
  const query: D1Query = async sql => {
    calls.push(sql)
    return env.DB.batch(splitStatements(sql).map(statement => env.DB.prepare(statement)))
  }
  return { db: env.DB, query, calls }
})
