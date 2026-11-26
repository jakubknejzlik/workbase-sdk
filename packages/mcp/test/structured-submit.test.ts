import { afterEach, describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import * as submission from '../src/submit-change.ts'
import { WorkflowError } from '../src/schemas.ts'

type Request = { changes: unknown[]; baseSha: string; proposalId: string }
type Api = {
  structuredSubmitRequestSchema: z.ZodType<Request>
  structuredSubmitRequestDigest: (input: unknown) => string
  createStructuredSubmitTransport: (config: { endpoint: string; credentialProvider?: () => string | Promise<string>; fetch?: typeof fetch }) => { submit(input: unknown, signal?: AbortSignal): Promise<unknown> }
}
function api(): Api {
  const candidate = submission as Partial<Api>
  expect(candidate.structuredSubmitRequestSchema, 'structured transport API unavailable').toBeDefined()
  expect(candidate.structuredSubmitRequestDigest, 'structured transport API unavailable').toBeTypeOf('function')
  expect(candidate.createStructuredSubmitTransport, 'structured transport API unavailable').toBeTypeOf('function')
  return candidate as Api
}
const endpoint = 'https://receiver.example.test/internal/submit'
const baseSha = 'a'.repeat(40)
const proposalId = '123e4567-e89b-42d3-a456-426614174000'
const operation = { kind: 'add_role', role: 'reviewer' }
const request = (): Request => ({ changes: [{ ...operation }], baseSha, proposalId })
const success = { ok: true, prUrl: 'https://example.test/pull/7', prNumber: 7, headSha: 'b'.repeat(40), checkState: 'pending', previewState: 'success' }
const reply = (data: unknown = success, status = 200) => new Response(JSON.stringify(data), { status })
const sentinel = 'SYNTHETIC_SECRET_DO_NOT_LEAK'
const unavailable = { code: 'structured_submit_unavailable', message: 'Structured submission is unavailable.', status: 503 }
const conflict = { code: 'structured_submit_conflict', message: 'Structured submission conflicts with an existing proposal.', status: 409 }
afterEach(() => vi.restoreAllMocks())

describe('strict structured submission', () => {
  it('exports the contract through the existing submit module', () => { api() })

  it('sends validated operations from all three families in one fixed HTTP request', async () => {
    const { createStructuredSubmitTransport, structuredSubmitRequestSchema } = api()
    const input = { ...request(), changes: [operation,
      { kind: 'set_label', entity: 'sample', field: 'title', language: 'en', label: 'SQL receipt token files' },
      { kind: 'set_interactive', interactive: true },
      { kind: 'set_constraints', entity: 'sample', constraints: [{ kind: 'unique', name: 'sample_title', fields: ['title'], where: { field: 'title', op: 'eq', value: 'SQL' } }] },
      { kind: 'set_computed_field', entity: 'sample', field: 'title', computed: { sql: 'caption data', token: { b: 2, a: 1 } } },
      { kind: 'set_policy', entity: 'sample', role: 'reviewer', policy: { where: { sql: 'predicate data', receipt: true } } },
    ] }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply())
    const credentialProvider = vi.fn(() => 'synthetic-token')
    const signal = new AbortController().signal
    const config = { endpoint, fetch: fetcher, credentialProvider }
    const client = createStructuredSubmitTransport(config)
    config.endpoint = 'https://other.example.test/'
    expect(await client.submit(input, signal)).toEqual(success)
    expect(credentialProvider).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe(endpoint)
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', signal })
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-token')
    const body = JSON.parse(init?.body as string)
    expect(Object.keys(body).sort()).toEqual(['baseSha', 'changes', 'proposalId'])
    expect(body.changes).toEqual(structuredSubmitRequestSchema.parse(input).changes)
  })

  const authority = ['files', 'sql', 'receipt', 'token', 'promotedFiles', 'migrationSql', 'digest', 'hash', 'repository', 'branch', 'path', 'endpoint', 'credentials', 'instance']
  it.each(authority)('rejects envelope authority member %s before auth/network', async member => {
    const contract = api()
    const fetcher = vi.fn<typeof fetch>()
    const credentialProvider = vi.fn(() => sentinel)
    const client = contract.createStructuredSubmitTransport({ endpoint, fetch: fetcher, credentialProvider })
    await expect(client.submit({ ...request(), [member]: sentinel })).rejects.toMatchObject({ code: 'invalid_structured_submit_request', status: 400 })
    expect(credentialProvider).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects nested operation extras in every family', async () => {
    const contract = api()
    const fetcher = vi.fn<typeof fetch>()
    const credentialProvider = vi.fn(() => sentinel)
    const client = contract.createStructuredSubmitTransport({ endpoint, fetch: fetcher, credentialProvider })
    for (const change of [operation, { kind: 'set_interactive', interactive: true }, { kind: 'set_constraints', entity: 'sample', constraints: [] }]) {
      for (const member of ['files', 'sql', 'receipt', 'token']) {
        const input = { ...request(), changes: [{ ...change, [member]: sentinel }] }
        expect(contract.structuredSubmitRequestSchema.safeParse(input).success).toBe(false)
        await expect(client.submit(input)).rejects.toMatchObject({ code: 'invalid_structured_submit_request' })
      }
    }
    await expect(client.submit({ ...request(), changes: [{ kind: 'add_field', entity: 'sample', field: 'title', definition: { type: 'text', token: sentinel } }] })).rejects.toMatchObject({ code: 'invalid_structured_submit_request' })
    expect(credentialProvider).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects missing fields, invalid types, identifiers, bounds and original non-JSON data', async () => {
    const contract = api()
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { throw new Error(sentinel) } })
    const invalid = [null, {}, { changes: [operation], baseSha }, { changes: [operation], proposalId }, { baseSha, proposalId }, { ...request(), baseSha: 'A'.repeat(40) }, { ...request(), baseSha: 'a'.repeat(39) },
      { ...request(), proposalId: 'invalid' }, { ...request(), changes: [] }, { ...request(), changes: Array(51).fill(operation) },
      { ...request(), changes: [{ kind: 'unknown' }] }, { ...request(), changes: [{ kind: 'add_role', role: '../invalid' }] },
      { ...request(), changes: [{ kind: 'set_interactive', interactive: 'true' }] },
      ...[undefined, () => 1, 1n, NaN, Infinity, -Infinity, cycle, new Date(), new Map(), new Set(), /x/, getter, Symbol('x'), Object.assign([], { extra: 1 }), Array(1)].map(value => ({ ...request(), changes: [{ kind: 'set_computed_field', entity: 'sample', field: 'title', computed: { value } }] })),
      { ...request(), [Symbol('hidden')]: 'ignored' },
    ]
    const credentialProvider = vi.fn(() => sentinel)
    const fetcher = vi.fn<typeof fetch>()
    const client = contract.createStructuredSubmitTransport({ endpoint, fetch: fetcher, credentialProvider })
    for (const input of invalid) {
      expect(contract.structuredSubmitRequestSchema.safeParse(input).success).toBe(false)
      await expect(client.submit(input)).rejects.toMatchObject({ code: 'invalid_structured_submit_request' })
      expect(() => contract.structuredSubmitRequestDigest(input)).toThrow(WorkflowError)
    }
    expect(credentialProvider).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('matches an independently authored canonical body and SHA256 golden without mutation', async () => {
    const contract = api()
    const input = Object.freeze({ proposalId, changes: Object.freeze([Object.freeze({ role: 'reviewer', kind: 'add_role' })]), baseSha })
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply())
    await contract.createStructuredSubmitTransport({ endpoint, fetch: fetcher }).submit(input)
    const golden = '{"baseSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","changes":[{"kind":"add_role","role":"reviewer"}],"proposalId":"123e4567-e89b-42d3-a456-426614174000"}'
    expect(fetcher.mock.calls[0]![1]?.body).toBe(golden)
    expect(contract.structuredSubmitRequestDigest(input)).toBe('020b2624a12edb77dde6f165cd40f2dce129fee225b3cf648a0c0d5310306fdf')
    expect(contract.structuredSubmitRequestDigest(input)).toBe(contract.structuredSubmitRequestDigest(request()))
    expect(input).toEqual(request())
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).has('authorization')).toBe(false)
    const batch = { ...request(), changes: [operation, { kind: 'set_interactive', interactive: true }] }
    for (const changed of [{ ...request(), baseSha: 'c'.repeat(40) }, { ...request(), changes: [{ ...operation, role: 'reader' }] }, { ...batch, changes: [...batch.changes].reverse() }]) {
      expect(contract.structuredSubmitRequestDigest(changed)).not.toBe(contract.structuredSubmitRequestDigest(batch))
      expect(contract.structuredSubmitRequestDigest(changed)).not.toBe(contract.structuredSubmitRequestDigest(request()))
    }
    const expression = (computed: unknown) => ({ ...request(), changes: [{ kind: 'set_computed_field', entity: 'sample', field: 'title', computed }] })
    expect(contract.structuredSubmitRequestDigest(expression({ z: { b: 2, a: 1 }, a: 0 }))).toBe(contract.structuredSubmitRequestDigest(expression({ a: 0, z: { a: 1, b: 2 } })))
  })

  it('makes explicit retries byte-identical and reports simulated conflict without retrying', async () => {
    const contract = api()
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => reply()).mockImplementationOnce(async () => reply()).mockImplementationOnce(async () => reply({ message: sentinel }, 409))
    const client = contract.createStructuredSubmitTransport({ endpoint, fetch: fetcher })
    expect(await client.submit(request())).toEqual(success)
    expect(await client.submit(request())).toEqual(success)
    expect(fetcher.mock.calls[0]![1]?.body).toBe(fetcher.mock.calls[1]![1]?.body)
    await expect(client.submit({ ...request(), changes: [{ ...operation, role: 'reader' }] })).rejects.toMatchObject(conflict)
    expect(fetcher.mock.calls[2]![1]?.body).not.toBe(fetcher.mock.calls[0]![1]?.body)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('fails closed on invalid configuration', () => {
    const contract = api()
    for (const config of [undefined, {}, { endpoint: 'http://receiver.example.test/' }, { endpoint: 'invalid' }, { endpoint: 'https://user:pass@example.test/' }, { endpoint: endpoint + '#fragment' }, { endpoint, fetch: 42 }, { endpoint, fetch: null }, { endpoint, credentialProvider: 'token' }]) {
      expect(() => contract.createStructuredSubmitTransport(config as Parameters<Api['createStructuredSubmitTransport']>[0])).toThrowError(expect.objectContaining(unavailable))
    }
  })

  it('uses global fetch by default', async () => {
    const contract = api()
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply())
    expect(await contract.createStructuredSubmitTransport({ endpoint }).submit(request())).toEqual(success)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed successes, remote failures, credential errors and abort without leaks or retry', async () => {
    const contract = api()
    const logs = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {})]
    const badSuccesses = [null, { ...success, extra: sentinel }, { ...success, ok: false }, { ...success, prUrl: 'http://example.test/' }, { ...success, prNumber: 0 }, { ...success, prNumber: 1.5 }, { ...success, headSha: 'B'.repeat(40) }, { ...success, checkState: 'unknown' }, { ...success, previewState: 'unknown' }, { ...success, headSha: undefined }]
    const responses = [...badSuccesses.map(data => () => Promise.resolve(reply(data))),
      () => Promise.resolve(new Response(sentinel)),
      ...[401, 500, 302].map(status => () => Promise.resolve(reply({ error: sentinel }, status))),
      () => Promise.reject(new Error(sentinel)),
      () => Promise.reject(new TypeError('redirect ' + sentinel)),
    ]
    async function expectUnavailable(promise: Promise<unknown>) {
      await expect(promise).rejects.toMatchObject(unavailable)
      await expect(promise).rejects.toBeInstanceOf(WorkflowError)
      await expect(promise).rejects.toSatisfy((error: unknown) => !((String(error) + JSON.stringify(error)).includes(sentinel)))
    }
    for (const response of responses) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(response)
      const client = contract.createStructuredSubmitTransport({ endpoint, fetch: fetcher })
      await expectUnavailable(client.submit(request()))
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
    for (const credentialProvider of [() => { throw new Error(sentinel) }, async () => { throw new Error(sentinel) }, () => '', () => 'invalid\r\n' + sentinel]) {
      const fetcher = vi.fn<typeof fetch>()
      await expectUnavailable(contract.createStructuredSubmitTransport({ endpoint, fetch: fetcher, credentialProvider }).submit(request()))
      expect(fetcher).not.toHaveBeenCalled()
    }
    const controller = new AbortController(); controller.abort(sentinel)
    const abortedFetch = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => { expect(init?.signal).toBe(controller.signal); throw new Error(sentinel) })
    await expectUnavailable(contract.createStructuredSubmitTransport({ endpoint, fetch: abortedFetch }).submit(request(), controller.signal))
    expect(abortedFetch).toHaveBeenCalledTimes(1)
    for (const log of logs) expect(log).not.toHaveBeenCalled()
  })
})
