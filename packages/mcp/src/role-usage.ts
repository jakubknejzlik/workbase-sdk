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
  if (!roles.length) return
  try {
    const databases = z.record(z.string(), z.string()).parse(JSON.parse(process.env.WORKBASE_MCP_ROLE_DATABASES ?? '{}'))
    const path = databases[instance]
    if (!path || !isAbsolute(path)) throw new Error('Target database unavailable')
    await noLink(path)
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      const placeholders = roles.map(() => '?').join(',')
      // Include historical/revoked/expired rows too: any stored role is a reference.
      // Missing tables and query failures cannot be mistaken for an unused role.
      for (const table of ['memberships', 'invitations', 'access_tokens']) {
        const row = db.prepare(`SELECT role FROM ${table} WHERE role IN (${placeholders}) LIMIT 1`).get(...roles)
        if (row) fail('role_in_use', `Role ${row.role} is held in target database ${table}`, 409)
      }
    } finally { db.close() }
  } catch (error) {
    if (error instanceof WorkflowError && error.code === 'role_in_use') throw error
    fail('role_usage_unverified', 'Cannot verify removed roles against the target D1 database; configure WORKBASE_MCP_ROLE_DATABASES with its absolute SQLite path', 409)
  }
}
