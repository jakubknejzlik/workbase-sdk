import type { ConsoleCapabilities } from './queries'

/** Only collection/settings context transfers. Record IDs and operation URLs belong to one scope. */
export function organizationDestination(pathname: string, orgId: string, caps: ConsoleCapabilities) {
  const base = `/o/${encodeURIComponent(orgId)}`
  const tail = pathname.replace(/^\/o\/[^/]+/, '').replace(/\/$/, '')
  const grants = caps.resources ?? {}
  if (['/settings', '/settings/profile'].includes(tail)) return `${base}/settings/profile`
  const grant: Record<string, string> = {
    '/settings/workspace-settings': 'organizations.update', '/settings/workspace-members': 'members.read',
    '/settings/invitations': 'invitations.read', '/settings/api-tokens': 'tokens.read',
    '/members': 'members.read', '/invitations': 'invitations.read', '/tokens': 'tokens.read',
    '/audit': 'audit.read', '/workflows': 'workflows.read',
    '/settings/activity': 'audit.read', '/settings/workflows': 'workflows.read',
  }
  if (grant[tail] && grants[grant[tail]]) return base + tail
  const entity = /^\/e\/([A-Za-z0-9_]+)$/.exec(tail)?.[1]
  if (entity && caps.entities[entity]?.operations.includes('read') && caps.entities[entity].readable.includes('id')) return base + tail
  return base
}
