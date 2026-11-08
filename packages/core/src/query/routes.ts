import { randomToken } from '../crypto'
import type { App, RuntimeEnv } from '../types'
import type { KernelRegistry } from '../kernel/registry'
import { QueryError } from './errors'
import { QUERY_LIMITS as L } from './limits'
import { observeQuery } from './observability'
import { executeQuery } from './executor'
const ephemeralSecrets = new WeakMap<RuntimeEnv, string>()
const cursorKeys = new WeakMap<RuntimeEnv, { source: string; key: Promise<string> }>()
export function cursorSecret(env: RuntimeEnv): Promise<string> {
  const configured = env.IDENTITY?.secret ?? env.BETTER_AUTH_SECRET ?? env.INTERNAL_TOKEN
  let secret = configured ?? ephemeralSecrets.get(env)
  if (!secret) { secret = randomToken(); ephemeralSecrets.set(env, secret) }
  const cached = cursorKeys.get(env)
  if (cached?.source === secret) return cached.key
  const key = deriveCursorKey(secret).catch(error => {
    if (cursorKeys.get(env)?.key === key) cursorKeys.delete(env)
    throw error
  })
  cursorKeys.set(env, { source: secret, key })
  return key
}
async function deriveCursorKey(secret: string): Promise<string> {
  const encode = (value: string) => new TextEncoder().encode(value)
  const material = await crypto.subtle.importKey('raw', encode(secret), 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256',
    salt: encode('workbase:query-cursor:hkdf-sha256:v1'), info: encode('workbase:query-cursor:v1'),
  }, material, 256)
  return [...new Uint8Array(bits)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
async function readInput(request: Request): Promise<string> {
  const reader = request.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []; let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > L.inputBytes) { await reader.cancel(); throw new QueryError('query_too_expensive') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(length); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) }
  catch { throw new QueryError('query_invalid') }
}
export function queryRoutes(app: App, kernel: KernelRegistry, env: RuntimeEnv) {
  app.post('/query', c => observeQuery(env.DB, c.get('scope'), async (writeLog, rejectedInput) => {
    let text = ''; let input: unknown
    try { text = await readInput(c.req.raw); input = JSON.parse(text) }
    catch (error) {
      const failure = error instanceof QueryError ? error : new QueryError('query_invalid')
      await rejectedInput(text)
      throw failure
    }
    return c.json(await executeQuery(kernel, c.get('scope'), env.DB, await cursorSecret(env), input, { writeLog }))
  }))
}
