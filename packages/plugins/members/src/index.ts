import { rowPendingIndexSQL, rowExpiryTriggerSQL } from './migrations/004-row-invitations'
import { migrations } from './migrations/index'
import { z } from 'zod'
import { builtinPlugin } from '@workbasehq/core/kernel/builtin-source'
import type { WorkbasePlugin } from '@workbasehq/core/kernel/plugin'
import { memberRoutes } from './routes'
import { recipientPendingIndexSQL, recipientExpiryTriggerSQL } from './migrations/003-recipients'
export { renderInvitationEmail, type InvitationEmailInput, type RenderedInvitationEmail } from './emails/invitation-email'

/** Memberships and invitations work independently of multi-tenant organization UI. */
export const members: WorkbasePlugin = builtinPlugin({
  name: 'members', version: '0.1.0', provides: { members: '1.x' },
  requires: { identity: '^1', permissions: '^1' }, optionalRequires: { organizations: '^1', 'mail-outbox': '^1', console: '^1' },
  contributes: { console: {
    pages: [{ id: 'members.list', path: '/settings/workspace-members', label: 'members', grant: 'members.read', renderer: 'members.list' }],
    navigation: [{ id: 'members.list', placement: 'settings', page: 'members.list', label: 'members', order: 30, grant: 'members.read' }],
  } },
  migrations,
  async checkSchema(db) {
    await db.prepare('SELECT scope_id FROM memberships LIMIT 0').all()
    await db.prepare('SELECT target_entity,target_row,scope_id,expired_at,delivery_outbox_id,bound_user_id,name_first,name_last,declined_at FROM invitations INDEXED BY invitations_one_pending_email WHERE accepted_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL AND declined_at IS NULL LIMIT 0').all()
    const definitions = await db.prepare("SELECT name,sql FROM sqlite_master WHERE name IN ('invitations_one_pending_email','invitations_expire_before_insert','invitations_one_pending_row','invitations_row_expire_before_insert')").all<{ name: string; sql: string }>()
    const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim().toLowerCase()
    for (const [name, expected] of [['invitations_one_pending_email', recipientPendingIndexSQL], ['invitations_expire_before_insert', recipientExpiryTriggerSQL], ['invitations_one_pending_row', rowPendingIndexSQL], ['invitations_row_expire_before_insert', rowExpiryTriggerSQL]]) {
      if (normalize(definitions.results.find(row => row.name === name)?.sql ?? '') !== normalize(expected)) throw new Error('members_pending_constraint_mismatch')
    }
  },
  policyInConfig: true,
  tableFilter: (_entity, scope) => ({ kind: 'where', predicate: { organization_id: { eq: scope.organizationId } } }),
  routes: memberRoutes,
})

/** Explicit factory; members remains the compatibility descriptor. */
export function createMembers(): WorkbasePlugin { return builtinPlugin({ ...members, configuration: Object.freeze({}), configSchema: z.strictObject({}).default({}) }) }
