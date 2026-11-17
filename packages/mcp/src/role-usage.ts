import { DatabaseSync } from 'node:sqlite'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { noLink } from './paths'
import { fail, WorkflowError, type Change } from './schemas'

/** Trusted operator mapping to the target local D1 SQLite files. Never a tool input,
 * never the empty disposable DB. Open read-only afresh at verification AND promotion.
 * A missing/inaccessible target (including a remote-only deployment) fails closed.
 */
export async function assertRemovedRolesUnused(instance: string, changes: Change[]) {
  const roles = [...new Set(changes.filter(c => c.kind === 'remove_role').map(c => c.role))]
  return assertRoleTargetSafe(instance, roles, false)
}

/** Composition computes removals from the complete old/final role sets. Owner
 * replacement additionally requires no organizations or memberships at all. */
export async function assertRoleTargetSafe(instance: string, roles: string[], ownerChanged: boolean) {
  if (!roles.length && !ownerChanged) return
  try {
    const databases = z.record(z.string(), z.string()).parse(JSON.parse(process.env.WORKBASE_MCP_ROLE_DATABASES ?? '{}'))
    const path = databases[instance]
    if (!path || !isAbsolute(path)) throw new Error('Target database unavailable')
    await noLink(path)
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      db.exec('BEGIN')
      if (ownerChanged) for (const table of ['organizations', 'memberships']) {
        if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) {
          fail('owner_change_requires_fresh_target', `Cannot change organizationOwnerRole: target ${table} is populated; owner-role changes require a fresh local target with no organizations or memberships`, 409)
        }
      }
      const placeholders = roles.map(() => '?').join(',')
      // Include historical/revoked/expired rows too: any stored role is a reference.
      // Missing tables and query failures cannot be mistaken for an unused role.
      for (const table of ['memberships', 'invitations', 'access_tokens']) {
        // Even an owner-only change must establish that target evidence is
        // complete. Missing tables cannot prove freshness or role absence.
        if (!roles.length) { db.prepare(`SELECT role FROM ${table} LIMIT 1`).get(); continue }
        const row = db.prepare(`SELECT role FROM ${table} WHERE role IN (${placeholders}) LIMIT 1`).get(...roles)
        if (row) fail('role_in_use', `Role ${row.role} is held in target database ${table}`, 409)
      }
    } finally { db.close() }
  } catch (error) {
    if (error instanceof WorkflowError && ['role_in_use', 'owner_change_requires_fresh_target'].includes(error.code)) throw error
    fail('role_usage_unverified', 'Cannot verify role removal or owner-role freshness against the target D1 database; configure WORKBASE_MCP_ROLE_DATABASES with its absolute SQLite path', 409)
  }
}
