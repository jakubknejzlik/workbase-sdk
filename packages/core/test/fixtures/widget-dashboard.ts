import { defineConfig, bindSchemaLock, defineEntity, defineAccess, accountLink, accessEntities, accessSystemActions } from '../../src/schema'
import { schemaLock } from '../../src/migrations/schema-lock'
import { identity } from '@workbasehq/plugins/identity'
import { localAuth } from '@workbasehq/plugins/local-auth'
import { legacyPermissions } from '@workbasehq/plugins/permissions'
import { members } from '@workbasehq/plugins/members'
import { organizations } from '@workbasehq/plugins/organizations'
import { consoleUI } from '@workbasehq/plugins/console'
import type { ConsoleWidget } from '../../src/console-contract'

export const referenceQuery = { entity: 'jobs', select: ['id', 'title', 'account_id', 'created_at', 'updated_at'], labels: ['account_id'], limit: 5 }
export function widgetDashboard(repeatedPolicy = 1, restrictedView = false, seamWidgets = false) {
  const all = { read: 'allow', create: 'allow', update: 'allow', delete: 'allow' } as const
  const read = (where: Record<string, unknown>) => ({ read: { where }, create: 'deny', update: 'deny', delete: 'deny' } as const)
  const widgets: ConsoleWidget[] = [
    { id: 'count', label: 'Job count', kind: 'stat', query: { entity: 'jobs' }, aggregate: { fn: 'count' } },
    { id: 'references', label: 'Recent jobs', kind: 'table', columns: ['title', 'account_id'], query: referenceQuery },
    { id: 'plain', label: 'Job titles', kind: 'list', field: 'title', query: { entity: 'jobs', select: ['id', 'title'], limit: 5 } },
  ]
  const namedQuery = { entity: 'jobs', select: ['id'], limit: 5, view: 'named' }
  if (seamWidgets) widgets.push({ id: 'records', label: 'Account overview', kind: 'table', columns: ['name', 'user'], query: { entity: 'accounts', select: ['id', 'name', 'user'], labels: ['user'], limit: 5 } })
  const invalidQuery = { entity: 'jobs', select: ['id'], limit: 5, contextList: { entity: 'jobs', list: 'missing', id: 'own' } }
  if (restrictedView) widgets.push(
    { id: 'named', label: 'Named records', kind: 'table', columns: ['id'], query: namedQuery },
    { id: 'denied', label: 'Hidden records', kind: 'table', columns: ['title'], query: { ...invalidQuery, select: ['id', 'title'] } },
    { id: 'invalid', label: 'Unavailable records', kind: 'table', columns: ['id'], query: invalidQuery },
  )
  const config = defineConfig({ id: 'widget_dashboard', roles: ['owner', 'staff'], organizationOwnerRole: 'owner', languages: ['en', 'cs'], interactive: true,
    plugins: [identity, localAuth, legacyPermissions, members, organizations, consoleUI(), {
      name: 'widget-dashboard', version: '1', requires: { console: '^1' }, contributes: { console: {
        pages: [{ id: 'summary', path: '/summary', label: 'Summary', widgets, sections: [{ row: ['count', 'references'] }, { row: seamWidgets ? ['records', 'plain'] : ['plain'] }] }],
        navigation: [{ id: 'summary', placement: 'sidebar', page: 'summary', label: 'Summary' }],
      } },
    }],
    entities: {
      accounts: defineEntity({ displayField: 'name', fields: { name: { type: 'string' }, user: accountLink(), team_id: { type: 'ref', entity: 'teams' }, supervisor_id: { type: 'ref', entity: 'users' }, groupx_id: { type: 'ref', entity: 'teams' } },
        access: { owner: all, staff: read({ user: { eq: '$actor.id' } }) } }),
      jobs: defineEntity({ displayField: 'title', fields: { title: { type: 'string' }, account_id: { type: 'ref', entity: 'accounts' }, owner_id: { type: 'ref', entity: 'users' }, creator_id: { type: 'ref', entity: 'users' }, team_id: { type: 'ref', entity: 'teams' } },
        relations: { account: { entity: 'accounts', field: 'account_id' } },
        access: { owner: all, staff: { ...read({ or: Array.from({ length: repeatedPolicy }, () => ({ account: { user: { eq: '$actor.id' } } })) }), ...(restrictedView ? { read: { where: { account: { user: { eq: '$actor.id' } } }, fields: ['id', 'account_id', 'created_at', 'updated_at'] } } : {}) } } }),
      teams: defineEntity({ displayField: 'name', fields: { name: { type: 'string' } }, access: { owner: all, staff: { read: 'allow', create: 'deny', update: 'deny', delete: 'deny' } } }),
    },
    access: defineAccess({ accountLinks: { accounts: { invitationRole: 'staff' } }, predicates: {},
      roles: Object.fromEntries(['owner', 'staff'].map(role => [role, { system: Object.fromEntries(accessSystemActions.map(action => [action, role === 'owner' ? 'allow' : 'deny'])) }])),
      entities: Object.fromEntries(accessEntities.map(entity => [entity, { owner: all, staff: entity === 'users' ? { read: 'allow', create: 'deny', update: 'deny', delete: 'deny' } : 'deny' }])),
    }),
    ui: { entities: { jobs: { list: { columns: ['title', 'account_id'], ...(restrictedView ? { views: [{ id: 'named', label: 'Named', where: { title: { eq: 'Example job' } } }] } : {}) } } } },
  })
  return bindSchemaLock(config, schemaLock(config))
}

/** Synthetic accounts, linked/other/foreign rows shared by runtime and browser checks. */
export async function seedWidgetDashboard(db: D1Database) {
  const { sha256 } = await import('../../src/crypto')
  const now = '2026-11-24T00:00:00.000Z'
  await db.exec("INSERT INTO organizations VALUES ('org-a','Example workspace'),('org-b','Other workspace')")
  for (const [id, role] of [['owner-a', 'owner'], ['viewer-a', 'staff']]) {
    await db.prepare("INSERT INTO users (id,organization_id,email,name,role,created_at,updated_at) VALUES (?,'org-a',?,?,?,?,?)").bind(id, `${id}@example.test`, 'Alex Example', role, now, now).run()
    await db.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(id, 'Alex Example', `${id}@example.test`, now, now).run()
    await db.prepare('INSERT INTO identity_profiles (user_id,first_name,last_name,updated_at) VALUES (?,?,?,?)').bind(id, 'Alex', 'Example', now).run()
    await db.prepare("INSERT INTO identities VALUES (?,'local','local',?,?)").bind(id, id, now).run()
    await db.prepare("INSERT INTO memberships VALUES (?,'org-a',?)").bind(id, role).run()
    await db.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(await sha256(`synthetic-${id}`), id, new Date(Date.now() + 3600000).toISOString()).run()
  }
  for (const [id, org, user, title] of [['own', 'org-a', 'viewer-a', 'Example job'], ['other', 'org-a', 'owner-a', 'Other job'], ['foreign', 'org-b', null, 'Foreign job']] as const) {
    await db.prepare('INSERT INTO accounts (id,organization_id,name,user,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind(id, org, 'Alex Example', user, now, now).run()
    await db.prepare('INSERT INTO jobs (id,organization_id,title,account_id,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind(id, org, title, id, now, now).run()
  }
}
