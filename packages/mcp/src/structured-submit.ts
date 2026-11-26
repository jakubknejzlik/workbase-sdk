import { createHash } from 'node:crypto'
import { z } from 'zod'
import { changeSchema, compositionChangeSchema, schemaChangeSchema, fail } from './schemas.ts'

// Inspect descriptors before any schema transformation (including JSON.stringify
// in expression schemas). Never invoke getters/toJSON or discard non-JSON data.
function isJsonData(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || ancestors.has(value)) return false
  const array = Array.isArray(value)
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false
  if (array && Object.getPrototypeOf(value) !== Array.prototype) return false
  const keys = Reflect.ownKeys(value)
  if (array && keys.length !== value.length + 1) return false // holes or extra members
  ancestors.add(value)
  try {
    return keys.every(key => {
      if (array && key === 'length') return true
      if (typeof key !== 'string' || (array && !/^(0|[1-9][0-9]*)$/.test(key))) return false
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!
      return descriptor.enumerable === true && 'value' in descriptor && isJsonData(descriptor.value, ancestors)
    })
  } finally {
    ancestors.delete(value)
  }
}

// Write keys directly, rather than rebuilding objects: JSON.stringify reorders
// integer-like object keys. Array order remains part of request identity.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`
  }
  return JSON.stringify(value) as string
}

export const structuredSubmitRequestSchema = z.unknown().transform((value, ctx) => {
  try {
    if (isJsonData(value)) {
      // Normalize before existing expression schemas serialize object values, so
      // their serialized strings also have deterministic nested key order.
      return JSON.parse(canonicalJson(value)) as unknown
    }
  } catch { /* Excessive depth or an uninspectable object is invalid input. */ }
  ctx.addIssue({ code: 'custom', message: 'Expected plain JSON data.' })
  return z.NEVER
}).pipe(z.strictObject({
  changes: z.array(z.union([changeSchema, compositionChangeSchema, schemaChangeSchema])).min(1).max(50),
  baseSha: z.string().regex(/^[a-f0-9]{40}$/),
  proposalId: z.uuid(),
}))
export type StructuredSubmitRequest = z.infer<typeof structuredSubmitRequestSchema>

function encodeRequest(input: unknown): string {
  try {
    const result = structuredSubmitRequestSchema.safeParse(input)
    if (result.success) return canonicalJson(result.data)
  } catch { /* Do not expose input or schema/exception details. */ }
  return fail('invalid_structured_submit_request', 'Invalid structured submission request.')
}

/** Request identity only; never an authorization or verification proof. */
export function structuredSubmitRequestDigest(input: unknown): string {
  return createHash('sha256').update(encodeRequest(input), 'utf8').digest('hex')
}

const sha = z.string().regex(/^[a-f0-9]{40}$/)
const state = z.enum(['pending', 'success', 'failure'])
export const structuredSubmitResponseSchema = z.strictObject({
  ok: z.literal(true),
  prUrl: z.string().url().refine(value => new URL(value).protocol === 'https:'),
  prNumber: z.number().int().positive(),
  headSha: sha,
  checkState: state,
  previewState: state,
})
export type StructuredSubmitResponse = z.infer<typeof structuredSubmitResponseSchema>
export type StructuredSubmitTransportConfiguration = {
  endpoint: string
  /** Operator service token, sent as Bearer auth. Never a GitHub App credential. */
  credentialProvider?: () => string | Promise<string>
  fetch?: typeof globalThis.fetch
}
function unavailable(): never {
  return fail('structured_submit_unavailable', 'Structured submission is unavailable.', 503)
}

/** Operator configuration is captured once; submit accepts no routing/auth options. */
export function createStructuredSubmitTransport(configuration: StructuredSubmitTransportConfiguration) {
  let endpoint: string
  let fetcher: typeof globalThis.fetch
  let credentialProvider: StructuredSubmitTransportConfiguration['credentialProvider']
  try {
    const configuredEndpoint = configuration.endpoint
    const url = new URL(configuredEndpoint)
    if (typeof configuredEndpoint !== 'string' || configuredEndpoint.trim() !== configuredEndpoint || url.protocol !== 'https:' || url.username || url.password || url.hash) return unavailable()
    endpoint = url.href
    fetcher = configuration.fetch === undefined ? globalThis.fetch : configuration.fetch
    credentialProvider = configuration.credentialProvider
    if (typeof fetcher !== 'function' || (credentialProvider !== undefined && typeof credentialProvider !== 'function')) return unavailable()
  } catch { return unavailable() }

  return {
    async submit(input: unknown, signal?: AbortSignal): Promise<StructuredSubmitResponse> {
      const body = encodeRequest(input) // Must precede credentials and network.
      let response: Response
      try {
        const headers = new Headers({ 'content-type': 'application/json' })
        if (credentialProvider) {
          const token = await credentialProvider()
          if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) return unavailable()
          headers.set('authorization', `Bearer ${token}`)
        }
        response = await fetcher(endpoint, { method: 'POST', headers, body, redirect: 'error', signal })
      } catch { return unavailable() }
      if (response.status === 409) return fail('structured_submit_conflict', 'Structured submission conflicts with an existing proposal.', 409)
      if (!response.ok) return unavailable()
      try {
        const result = structuredSubmitResponseSchema.safeParse(await response.json())
        if (result.success) return result.data
      } catch { /* No remote body, provider text or exception detail escapes. */ }
      return unavailable()
    },
  }
}
