import { expect, test, vi } from 'vitest'
import { run } from '../../src/ops/cli.ts'

const env = { WORKBASE_BASE_URL: 'http://localhost:8997', WORKBASE_OPS_TOKEN: 'synthetic-cli-ops' }
const args = ['bootstrap-instance-owner', '--owner-email', 'first@example.test']
test('CLI rejects malformed arguments and authority overrides before making requests', async () => {
  const request = vi.fn<typeof fetch>()
  for (const input of [[], args.slice(0, 2), [...args, '--token', env.WORKBASE_OPS_TOKEN], ['bootstrap-instance-owner', '--token', env.WORKBASE_OPS_TOKEN]]) {
    expect(await run(input, env, request)).toEqual({ exitCode: 1, result: { ok: false, code: 'invalid_arguments', status: 400 } })
  }
  expect(await run([...args.slice(0, 2), 'invalid'], env, request)).toEqual({ exitCode: 1, result: { ok: false, code: 'validation_error', status: 400 } })
  expect(await run(args, {}, request)).toEqual({ exitCode: 1, result: { ok: false, code: 'invalid_environment', status: 400 } })
  expect(request).not.toHaveBeenCalled()
})

test('CLI returns a failing exit code for denials and suppresses secrets from every result', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ error: 'instance_owner_exists', hint: env.WORKBASE_OPS_TOKEN }, { status: 409 }))
    .mockRejectedValueOnce(new Error(env.WORKBASE_OPS_TOKEN))
    .mockResolvedValueOnce(Response.json({ user_id: env.WORKBASE_OPS_TOKEN }))
  expect(await run(args, env, request)).toEqual({ exitCode: 1, result: { ok: false, code: 'instance_owner_exists', status: 409 } })
  expect(await run(args, env, request)).toEqual({ exitCode: 1, result: { ok: false, code: 'transport_error', status: 502 } })
  expect(await run(args, env, request)).toEqual({ exitCode: 0, result: { ok: true, data: { user_id: '[redacted]' } } })
})
