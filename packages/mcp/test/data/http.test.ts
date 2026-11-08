import { beforeAll, afterAll, test } from 'vitest'
import { startFixture, type Fixture } from './fixture.ts'
import { cases } from './http-cases.ts'
let fixture: Fixture
beforeAll(async () => { fixture = await startFixture() })
afterAll(async () => { if (fixture) console.log('MCP_DATA_COUNTS', JSON.stringify(fixture.counts())); await fixture?.close() })
for (const [name, run] of cases) test(name, () => run(fixture))
