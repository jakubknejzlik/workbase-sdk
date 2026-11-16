import { organizationNameReasons, type OrganizationNameReason } from '@workbasehq/core/organization-name'
import { z } from 'zod'
import type { ToolName } from './schemas.ts'

export class ToolError extends Error {
  constructor(public code: string, public status: number, public detail?: { field: 'name'; reason: OrganizationNameReason }) { super('Workbase request failed') }
}
const baseUrl = z.url().refine(value => {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
      && (url.protocol !== 'http:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  } catch { return false }
})
const token = z.string().min(1).regex(/^[\x21-\x7e]+$/)
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(value => value === '' ? undefined : value, schema.optional())
const environment = z.object({
  WORKBASE_BASE_URL: baseUrl, WORKBASE_OPS_TOKEN: token,
  WORKBASE_DEV_MAILBOX_URL: optional(baseUrl),
  WORKBASE_DEV_MAILBOX_TOKEN: optional(token.min(32).max(256)),
}).refine(env => Boolean(env.WORKBASE_DEV_MAILBOX_URL) === Boolean(env.WORKBASE_DEV_MAILBOX_TOKEN))
export function loadEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const parsed = environment.safeParse(env)
  if (!parsed.success) throw new ToolError('invalid_environment', 400)
  return parsed.data
}

export function createApi(env: ReturnType<typeof loadEnvironment>, request: typeof fetch = fetch) {
  // Closure-held credentials are removed from values and keys in every tool result.
  const tokens = [env.WORKBASE_OPS_TOKEN, env.WORKBASE_DEV_MAILBOX_TOKEN].filter((value): value is string => Boolean(value))
    .sort((a, b) => b.length - a.length)
  const replacement = tokens.some(secret => '[redacted]'.includes(secret)) ? '' : '[redacted]'
  const redactText = (text: string) => {
    for (const secret of tokens) text = text.replaceAll(secret, replacement)
    return text
  }
  const redactValue = (value: unknown): unknown => typeof value === 'string' ? redactText(value)
    : Array.isArray(value) ? value.map(redactValue)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [redactText(key), redactValue(item)])) : value
  const redact = (value: Record<string, unknown>) => redactValue(value) as Record<string, unknown>
  async function call(name: ToolName, args: any, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const provisioning = name !== 'read_dev_mail'
    if (!provisioning && !env.WORKBASE_DEV_MAILBOX_URL) throw new ToolError('unknown_tool', 404)
    const base = (provisioning ? env.WORKBASE_BASE_URL : env.WORKBASE_DEV_MAILBOX_URL!).replace(/\/$/, '')
    const path = provisioning ? name === 'bootstrap_instance_owner' ? '/internal/members/instance-owner' : '/internal/organizations'
      : `/messages?${new URLSearchParams({ recipient: args.recipient, limit: String(args.limit) })}`
    let response: Response
    try {
      response = await request(`${base}${path}`, {
        method: provisioning ? 'POST' : 'GET', redirect: 'error',
        headers: provisioning ? { 'X-Internal-Token': env.WORKBASE_OPS_TOKEN, 'Content-Type': 'application/json' }
          : { Authorization: `Bearer ${env.WORKBASE_DEV_MAILBOX_TOKEN}` },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
        ...(provisioning ? { body: JSON.stringify({ ...(name === 'provision_organization' ? { name: args.name } : {}), ownerEmail: args.ownerEmail }) } : {}),
      })
    } catch { throw new ToolError('transport_error', 502) }
    // Upstream error text is never reflected, including non-JSON proxy failures.
    if (!response.ok) {
      if (name === 'provision_organization' && response.status === 400) {
        const body = await response.json().catch(() => null) as { error?: unknown; detail?: { field?: unknown; reason?: unknown } } | null
        if (body?.error === 'invalid_organization_name' && body.detail?.field === 'name' && organizationNameReasons.includes(body.detail.reason as OrganizationNameReason)) {
          throw new ToolError('invalid_organization_name', 400, { field: 'name', reason: body.detail.reason as OrganizationNameReason })
        }
      }
      let code = 'http_error'
      if (provisioning) {
        if (response.status === 403) code = 'internal_token_required'
        if (response.status === 503) code = 'internal_token_not_configured'
        if (response.status === 409) {
          code = name === 'bootstrap_instance_owner' ? 'membership_conflict' : 'owner_sign_in_required'
          try {
            const error = (await response.json() as { error?: unknown })?.error
            const allowed = name === 'bootstrap_instance_owner' ? ['owner_sign_in_required', 'instance_owner_exists', 'membership_conflict', 'account_already_assigned'] : ['account_already_assigned']
            if (typeof error === 'string' && allowed.includes(error)) code = error
          } catch { /* fixed fallback */ }
        }
      } else {
        code = ({ 400: 'invalid_query', 403: 'forbidden', 404: 'not_found', 405: 'method_not_allowed', 503: 'dev_mailbox_unavailable' } as Record<number, string>)[response.status] ?? code
      }
      throw new ToolError(code, response.status)
    }
    let value: unknown
    try { value = await response.json() } catch { throw new ToolError('invalid_response', 502) }
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || (!provisioning && !Array.isArray((value as Record<string, unknown>).messages))) throw new ToolError('invalid_response', 502)
    return value as Record<string, unknown>
  }
  return { call, redact }
}
