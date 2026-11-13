import type { Node } from './index'
export type FieldMeta = { type: string; required: boolean; readOnly: boolean; computed: boolean; userLink: boolean; values?: string[]; ref?: string }
export type EntityMeta = { displayField: string; fields: Record<string, FieldMeta> }
export type Issue = { path: (string | number)[]; code: string }
export class ApiFailure extends Error {
  constructor(public status: number, public code: string, public issues?: Issue[], public reason?: string) { super(code) }
}
export type RecordData = Record<string, unknown> & { id: string; version: number }
export type Member = { user_id: string; email: string }
export type ListData = { data: RecordData[]; next_cursor: string | null }
export type ClientRequestInit = RequestInit & { credentials?: 'same-origin' }
export type ListBind = { search?: string; sort?: string; dir?: string }
export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJSON((value as Record<string, unknown>)[key])).join(',') + '}'
  return JSON.stringify(value)
}
export const cacheKey = (kind: string, entity: string, request: unknown) => canonicalJSON({ kind, entity, request })
/** Only placed, editable fields can enter a generic write body. */
export function diff(meta: EntityMeta, layout: Node[], initial: Record<string, unknown>, draft: Record<string, unknown>, writable?: readonly string[]): Record<string, unknown> {
  const body: Record<string, unknown> = {}, issues: Issue[] = []
  function walk(nodes: Node[]) {
    for (const node of nodes) {
      if (typeof node !== 'string') { if (node.kind !== 'slot' && node.kind !== 'action') walk(node.children); continue }
      const field = meta.fields[node]
      if (writable && !writable.includes(node) || !field || field.readOnly || field.computed || field.userLink) continue
      let value = draft[node]
      if ((field.type === 'string' || field.type === 'text') && typeof value === 'string') value = value.trim()
      if (value === '' || value === null || value === undefined) {
        if (field.required) { issues.push({ path: [node], code: 'required' }); continue }
        value = null
      }
      if (value !== (initial[node] ?? null)) body[node] = value
    }
  }
  walk(layout)
  if (issues.length) throw new ApiFailure(400, 'validation_error', issues)
  return body
}
export function createClient(options: { baseURL: string; orgId: string; actorId: string; fetch: (url: string, init: ClientRequestInit) => Promise<Response>; onAuthorizationFailure?: (status: 401 | 403) => void }) {
  const transport = options.fetch
  const cache = new Map<string, unknown>(), latest = new Map<string, object>()
  let epoch = 0
  const listeners = new Set<() => void>()
  function invalidate(entity?: string, row?: RecordData) {
    epoch++; cache.clear()
    if (entity && row) cache.set(cacheKey('one', entity, { id: row.id }), row)
    for (const listener of listeners) listener()
  }
  async function wire(path: string, signal: AbortSignal, method = 'GET', body?: unknown, extra?: Record<string, string>) {
    signal.throwIfAborted()
    try {
      const response = await transport(options.baseURL.replace(/\/$/, '') + path, {
        signal, method, credentials: 'same-origin', headers: { 'X-Organization-Id': options.orgId, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      signal.throwIfAborted()
      if (response.status === 401 || response.status === 403) options.onAuthorizationFailure?.(response.status)
      const value = await response.json() as Record<string, unknown>
      signal.throwIfAborted()
      if (!response.ok) throw new ApiFailure(response.status, String(value.error ?? 'api_error'), value.issues as Issue[] | undefined, typeof value.reason === 'string' ? value.reason : undefined)
      return value
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof ApiFailure) throw error
      throw new ApiFailure(0, 'network')
    }
  }
  async function read<T>(kind: string, entity: string, request: unknown, signal: AbortSignal, fetcher: () => Promise<unknown>): Promise<T> {
    signal.throwIfAborted()
    const key = cacheKey(kind, entity, request)
    if (cache.has(key)) return cache.get(key) as T
    const ticket = {}, generation = epoch
    latest.set(key, ticket)
    const value = await fetcher()
    signal.throwIfAborted()
    if (generation !== epoch || latest.get(key) !== ticket) throw new DOMException('Superseded request', 'AbortError')
    latest.delete(key); cache.set(key, value)
    return value as T
  }
  const entityPath = (entity: string) => '/api/' + encodeURIComponent(entity)
  async function mutate(entity: string, path: string, method: string, body: unknown, headers: Record<string, string>, signal: AbortSignal) {
    const row = await wire(path, signal, method, body, headers) as RecordData
    invalidate(entity, row)
    return row
  }
  async function actWith(entity: string, id: string, name: string, body: Record<string, unknown>, signal: AbortSignal): Promise<{ record: RecordData; result: Record<string, unknown> }> {
    const detail = entityPath(entity) + '/' + encodeURIComponent(id)
    const result = await wire(detail + '/actions/' + encodeURIComponent(name), signal, 'POST', body)
    invalidate()
    const row = result.id === id && Number.isSafeInteger(result.version) && result.actions && typeof result.actions === 'object'
      ? result as RecordData : await wire(detail, signal) as RecordData
    invalidate(entity, row)
    return { record: row, result }
  }
  return {
    async members(signal: AbortSignal): Promise<Member[]> {
      const response = await wire('/orgs/' + encodeURIComponent(options.orgId) + '/members', signal)
      return (response.data as Member[]).map(({ user_id, email }) => ({ user_id, email }))
    },
    scope: { actorId: options.actorId, orgId: options.orgId },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    invalidate: () => invalidate(),
    one(entity: string, request: { id: string }, signal: AbortSignal, requireDetail = false): Promise<RecordData> {
      const key = cacheKey('one', entity, request), row = cache.get(key)
      // Generic mutation envelopes intentionally omit detail-only metadata.
      if (requireDetail && row && !Object.hasOwn(row as object, 'actions')) cache.delete(key)
      return read('one', entity, request, signal, () => wire(entityPath(entity) + '/' + encodeURIComponent(request.id), signal))
    },
    /** A list session owns its opaque forward cursor; search/sort changes start a new chain. */
    list(entity: string, meta: EntityMeta, readable?: readonly string[]) {
      let bind: ListBind = {}, cursor: string | null = null, generation = 0
      async function page(input: ListBind, signal: AbortSignal, more: boolean): Promise<ListData> {
        if (Object.keys(input).some(key => !['search', 'sort', 'dir'].includes(key)) || input.dir && !['asc', 'desc'].includes(input.dir) || input.sort && !readable && !(input.sort === 'id' || Object.hasOwn(meta.fields, input.sort))) throw new ApiFailure(0, 'manifest_error')
        const changed = canonicalJSON(input) !== canonicalJSON(bind)
        if (changed || !more) { cursor = null; generation++ }
        bind = { ...input }
        const ticket = generation
        const allowed = readable ? new Set(readable) : undefined
        const selected = [...new Set(['id', 'version', ...Object.keys(meta.fields)])].filter(field => !allowed || allowed.has(field))
        const sort = input.sort && (!allowed || allowed.has(input.sort)) ? input.sort : !allowed || allowed.has(meta.displayField) ? meta.displayField : 'id'
        const request = { entity, select: selected, limit: 25,
          orderBy: [{ field: sort, dir: input.dir || 'asc' }],
          ...(input.search && (!allowed || allowed.has(meta.displayField)) && meta.displayField !== 'id' ? { search: { text: input.search, fields: [meta.displayField] } } : {}), ...(more && cursor ? { cursor } : {}),
        }
        const result = await read<ListData>('list', entity, request, signal, () => wire('/query', signal, 'POST', request))
        signal.throwIfAborted()
        if (ticket !== generation) throw new DOMException('Superseded list', 'AbortError')
        cursor = result.next_cursor
        return result
      }
      return { load: (input: ListBind, signal: AbortSignal) => page(input, signal, false), more: (signal: AbortSignal) => page(bind, signal, true) }
    },
    async act(entity: string, id: string, name: string, signal: AbortSignal): Promise<RecordData> {
      return (await actWith(entity, id, name, {}, signal)).record
    },
    actWith,
    create: (entity: string, body: unknown, draftKey: string, signal: AbortSignal) => mutate(entity, entityPath(entity), 'POST', body, { 'Idempotency-Key': draftKey }, signal),
    update: (entity: string, id: string, version: number, body: unknown, signal: AbortSignal) => {
      if (!Number.isSafeInteger(version) || version < 1) throw new ApiFailure(400, 'version_required')
      return mutate(entity, entityPath(entity) + '/' + encodeURIComponent(id), 'PATCH', body, { 'If-Match': `"${version}"` }, signal)
    },
  }
}
export type Client = ReturnType<typeof createClient>
