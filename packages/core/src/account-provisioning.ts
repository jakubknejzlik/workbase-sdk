// Core-only: callers supply a live identity and the server-selected workspace role.
import type { InstanceConfig } from './config'
import type { SqlStatement } from './execution/types'
import { quote } from './migrations/schema'
import { ApiError } from './errors'
import type { RuntimeEnv } from './types'
export async function accountProvisioning(env: RuntimeEnv, config: InstanceConfig, user: { id: string; email: string }, organizationId: string, role: string, now: string, roleError = 'account_provisioning_required'): Promise<SqlStatement[]> {
  if (config.account?.entity !== 'users') return []
  const existing = await env.DB.prepare('SELECT organization_id FROM users WHERE id=?').bind(user.id).first<{ organization_id: string }>()
  if (existing) {
    // A physical domain account has a single organization. Never move it, or
    // silently reuse an account from another workspace.
    if (existing.organization_id !== organizationId) throw new ApiError(409, 'account_already_assigned')
    return []
  }
  const values: Record<string, string | number | null> = { id: user.id, email: user.email, organization_id: organizationId, created_at: now, updated_at: now, name: user.email }
  const compatibility = accountRoleValue(config, role, roleError)
  if (compatibility !== undefined) values.role = compatibility
  for (const field of Object.keys(values)) if (config.entities.users.fields[field]?.computed) delete values[field]
  for (const [field, definition] of Object.entries(config.entities.users.fields)) {
    if (definition.computed || Object.hasOwn(values, field)) continue
    if (definition.default !== undefined) values[field] = typeof definition.default === 'boolean' ? Number(definition.default) : definition.default
    else if (definition.required) throw new ApiError(422, 'account_provisioning_required')
  }
  return [{ sql: `INSERT INTO users (${Object.keys(values).map(quote).join(',')}) SELECT ${Object.keys(values).map(() => '?').join(',')} WHERE NOT EXISTS (SELECT 1 FROM users WHERE id=?)`, bindings: [...Object.values(values), user.id] }]
}

/** Legacy domain role is inert compatibility data, never membership authority. */
export function accountRoleValue(config: InstanceConfig, role: string, code = 'account_provisioning_required'): string | number | null | undefined {
  const field = config.entities.users.fields.role
  if (!field || field.computed) return undefined
  if (field.type !== 'enum' || field.values?.includes(role)) return role
  if (field.default !== undefined) return typeof field.default === 'boolean' ? Number(field.default) : field.default
  if (field.required) throw new ApiError(400, code)
  return null
}
