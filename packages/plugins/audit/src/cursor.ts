import { equalHash, sha256, signWebhook } from '@workbasehq/core/crypto'
import { ApiError } from '../../../core/src/errors'
export interface Position { range: number; prefix: string; cursor: string; after: string }
export async function encodePosition(secret: string, context: string, position: Position) {
  const payload = btoa(JSON.stringify({ v: 2, context: await sha256(context), ...position }))
  return `${payload}.${await signWebhook(secret, `audit-kv-v2.${payload}`)}`
}
export async function decodePosition(value: string, secret: string, context: string, ranges: string[]): Promise<Position> {
  try {
    if (value.length > 8000) throw new Error()
    const [payload, signature, extra] = value.split('.')
    if (extra !== undefined || !payload || !signature || !equalHash(signature, await signWebhook(secret, `audit-kv-v2.${payload}`))) throw new Error()
    const p = JSON.parse(atob(payload))
    if (p.v !== 2 || p.context !== await sha256(context) || !Number.isInteger(p.range) || p.range < 0 || p.range >= ranges.length
      || typeof p.cursor !== 'string' || p.cursor.length > 6000 || typeof p.prefix !== 'string' || !/^\d{0,17}$/.test(p.prefix)
      || !p.prefix.startsWith(ranges[p.range]) || typeof p.after !== 'string' || p.after.length > 512
      || (p.after !== '' && !/^\d{17}\//.test(p.after))) throw new Error()
    return { range: p.range, prefix: p.prefix, cursor: p.cursor, after: p.after }
  } catch { throw new ApiError(400, 'invalid_cursor') }
}
