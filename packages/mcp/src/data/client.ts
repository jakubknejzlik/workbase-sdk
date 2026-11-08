import { z } from 'zod'
import type { ToolName } from './schemas.ts'
export class ToolError extends Error {
  constructor(public code: string, public status: number, public envelope?: Record<string, unknown>) { super('Workbase request failed') }
}
const environment = z.object({
  WORKBASE_BASE_URL: z.url(), WORKBASE_TOKEN: z.string().min(1).refine(value => !/[\r\n]/.test(value)),
  WORKBASE_ORG_ID: z.string().min(1).max(200).refine(value => !/[\r\n]/.test(value)),
  WORKBASE_READ_ONLY: z.enum(['true', 'false']).optional(),
})
export function loadEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const parsed = environment.safeParse(env)
  if (!parsed.success) throw new ToolError('invalid_environment', 400)
  const url = new URL(parsed.data.WORKBASE_BASE_URL)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new ToolError('invalid_environment', 400)
  return parsed.data
}
export function createApi(env: ReturnType<typeof loadEnvironment>, request: typeof fetch = fetch) {
  const base = env.WORKBASE_BASE_URL.replace(/\/$/, '')
  // Kept in a closure, never attached to errors or returned in tool output.
  const redact = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll(JSON.stringify(env.WORKBASE_TOKEN).slice(1, -1), '[redacted]')) as Record<string, unknown>
  async function http(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}, signal?: AbortSignal, queryEnvelope = false) {
    let response: Response
    try {
      response = await request(`${base}${path}`, { method, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${env.WORKBASE_TOKEN}`, 'X-Organization-Id': env.WORKBASE_ORG_ID, 'Content-Type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    } catch { throw new ToolError('transport_error', 502) }
    if (response.status === 204) return { deleted: true }
    let value: any
    try { value = await response.json() } catch { throw new ToolError('invalid_response', 502) }
    if (!response.ok) throw new ToolError(typeof value?.error === 'string' ? value.error : 'http_error', response.status, queryEnvelope ? value : undefined)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ToolError('invalid_response', 502)
    return value
  }
  const segment = encodeURIComponent
  const query = (values: Record<string, unknown>) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(values)) if (value !== undefined) params.set(key, String(value))
    return params.size ? `?${params}` : ''
  }
  async function call(name: ToolName, args: any, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const get = (path: string) => http(path, 'GET', undefined, {}, signal)
    const write = (path: string, method: string, body?: unknown, headers: Record<string, string> = {}) => http(path, method, body, headers, signal)
    // Query documents must never pass through legacy URL-segment coercion.
    if (name === 'query') return http('/query', 'POST', args, {}, signal, true)
    const record = `/api/${segment(args?.entity ?? '')}`
    switch (name) {
      case 'describe_schema': return { health: await get('/health'), schema: await get('/schema') }
      case 'whoami': return get('/me?scope=organization')
      case 'list_records': return get(record + query({ ...args.filters, limit: args.limit, cursor: args.cursor }))
      case 'get_record': return get(`${record}/${segment(args.id)}`)
      case 'create_record': return write(record, 'POST', args.data, args.idempotencyKey ? { 'Idempotency-Key': args.idempotencyKey } : {})
      case 'update_record': return write(`${record}/${segment(args.id)}`, 'PATCH', args.data, { 'If-Match': String(args.version) })
      case 'delete_record': return write(`${record}/${segment(args.id)}`, 'DELETE')
      case 'run_command':
      case 'start_workflow': {
        // Positive registration check prevents generic names from selecting owner-only
        // /workflows/:id/cancel or /resume, including future routes under this prefix.
        const schema = await get('/schema')
        const workflow = name === 'start_workflow'
        const registered = workflow ? schema.workflows : schema.commands
        if (!Array.isArray(registered) || !registered.some((entry: any) => entry.name === args.name)) throw new ToolError(workflow ? 'workflow_not_found' : 'unsupported_command', workflow ? 404 : 405)
        return write(`/${workflow ? 'workflows' : 'commands'}/${args.name}`, 'POST', { ...args.input, ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}) })
      }
      case 'get_workflow': return get(`/workflows/${segment(args.id)}`)
      case 'list_workflows': return get('/workflows' + query({ status: args.status }))
      case 'read_audit': return get('/audit/events' + query({ entity: args.entity, entity_id: args.entityId, limit: args.limit, cursor: args.cursor }))
    }
  }
  return { call, redact }
}
