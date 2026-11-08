import { equalHash, sha256, signWebhook } from '../crypto'
import type { InstanceConfig } from '../config'
import type { Scope } from '../types'
import { requestHash } from '../idempotency'
import { invalid, QueryError } from './errors'
import { QUERY_LIMITS as L } from './limits'
import { fieldType, type QueryInput, type Scalar } from './schema'
import { labelPath } from './labels'
import { queryOrder } from './compiler'
const encode = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
const decode = (text: string) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0)))
/** Rejected inputs get a digest too; JSON/driver text is never logged. */
export async function inputHash(input: unknown) {
  let serialized = 'invalid-query'
  try { serialized = JSON.stringify(input) ?? serialized } catch { /* cycles / excessive recursion */ }
  return sha256(serialized)
}
export async function queryHash(config: InstanceConfig, scope: Scope, query: QueryInput) {
  const { cursor: _cursor, ...shape } = query
  return requestHash('query', { query: shape, revision: config.revision, organization: scope.organizationId, actor: scope.actor, role: scope.role })
}
export async function encodeCursor(secret: string, hash: string, revision: number, keys: Scalar[]) {
  const payload = encode(JSON.stringify({ hash, revision, keys }))
  if (payload.length + 65 > L.cursorBytes) throw new QueryError('query_too_expensive', ['cursor'])
  return `${payload}.${await signWebhook(secret, `workbase-query-cursor-v1.${payload}`)}`
}
export async function decodeCursor(secret: string, hash: string, config: InstanceConfig, query: QueryInput): Promise<Scalar[] | undefined> {
  if (!query.cursor) return undefined
  try {
    if (query.cursor.length > L.cursorBytes) invalid(['cursor'])
    const [payload, signature, extra] = query.cursor.split('.')
    if (extra !== undefined || !payload || !signature || !equalHash(signature, await signWebhook(secret, `workbase-query-cursor-v1.${payload}`))) invalid(['cursor'])
    const data = JSON.parse(decode(payload))
    const order = queryOrder(query)
    if (data.hash !== hash || data.revision !== config.revision || !Array.isArray(data.keys) || data.keys.length !== order.length) invalid(['cursor'])
    data.keys.forEach((key: unknown, i: number) => {
      const path = order[i].label ? labelPath(config, query.entity, order[i].field) : undefined
      const type = path?.display ? fieldType(config, path.entity, path.display) : fieldType(config, query.entity, order[i].field)
      if (key !== null && (['int', 'float', 'bool'].includes(type) ? typeof key !== 'number' || !Number.isFinite(key) : typeof key !== 'string')) invalid(['cursor'])
    })
    return data.keys
  } catch { return invalid(['cursor']) }
}
