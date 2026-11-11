import { beforeEach, expect, it } from 'vitest'
import { runtime, setup } from '@workbasehq/test-support/helpers'
import { createApp } from '../src/app'
import type { RuntimeEnv } from '../src/types'
import sample from './fixtures/sample/config'

const opsToken = 'synthetic-ops-token'
const internalToken = 'synthetic-legacy-token'

beforeEach(async () => { await setup() })

it.each([
  { name: 'OPS takes precedence', ops: opsToken, internal: internalToken, presented: opsToken, status: 200 },
  { name: 'legacy token rejected after transition', ops: opsToken, internal: internalToken, presented: internalToken, status: 403 },
  { name: 'OPS alone', ops: opsToken, internal: undefined, presented: opsToken, status: 200 },
  { name: 'wrong token', ops: opsToken, internal: internalToken, presented: 'synthetic-wrong-token', status: 403 },
  { name: 'missing token', ops: opsToken, internal: internalToken, presented: undefined, status: 403 },
  { name: 'legacy-only deployment', ops: undefined, internal: internalToken, presented: internalToken, status: 200 },
  { name: 'legacy-only missing token', ops: undefined, internal: internalToken, presented: undefined, status: 403 },
  { name: 'unconfigured', ops: undefined, internal: undefined, presented: internalToken, status: 503 },
])('$name: /internal/ops returns $status with safe diagnostics', async ({ ops, internal, presented, status }) => {
  const bindings: RuntimeEnv = { ...runtime(), OPS_TOKEN: ops, INTERNAL_TOKEN: internal }
  const app = createApp(sample, bindings)
  const response = await app.request('http://localhost/internal/ops', {
    headers: presented === undefined ? {} : { 'X-Internal-Token': presented },
  })
  expect(response.status).toBe(status)
  const body = await response.json()
  if (status === 200) {
    expect(body).toMatchObject({ bindings: { OPS_TOKEN: !!ops, INTERNAL_TOKEN: !!internal } })
    expect(JSON.stringify(body)).not.toContain(opsToken)
    expect(JSON.stringify(body)).not.toContain(internalToken)
  } else {
    expect(body).toEqual({ error: status === 503 ? 'internal_token_not_configured' : 'internal_token_required' })
  }
})
