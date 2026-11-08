import { z } from 'zod'
import { defineInstance, defineCommand } from '@workbasehq/core'
import { identity } from '@workbasehq/plugins/identity'
import { localAuth } from '@workbasehq/plugins/local-auth'
import { legacyPermissions } from '@workbasehq/plugins/permissions'
import { consoleUI } from '@workbasehq/plugins/console'
import { audit } from '@workbasehq/plugins/audit'
import { members } from '@workbasehq/plugins/members'
import { organizations } from '@workbasehq/plugins/organizations'
import type { WorkbasePlugin } from '@workbasehq/core/kernel/plugin'
import { canary } from './canary'
const check = defineCommand({ name: 'specimens/check', permission: { entity: 'specimens', operation: 'update' },
  ui: { label: 'Check sample' }, input: z.object({ specimen_id: z.string().min(1).meta({ referenceEntity: 'specimens' }), count: z.number().int().min(1).max(5) }),
  plan: (context, { specimen_id, count }) => ({ rules: [{ name: 'set_count', statements: [{ sql: 'UPDATE specimens SET quantity=?,version=version+1,updated_at=? WHERE id=? AND organization_id=?', bindings: [count, context.now, specimen_id, context.scope.organizationId], expectRows: 1 }] }], result: { status: 200, body: { count } }, event: { entity: 'specimens', entityId: specimen_id, operation: 'specimen.checked', after: { quantity: count } } }),
})
const dashboard: WorkbasePlugin = { name: 'neutral-dashboard', version: '1.0.0', requires: { console: '^1' }, commands: [check], contributes: { console: {
  pages: [{ id: 'neutral.summary', path: '/summary', label: 'Summary', widgets: [
    { id: 'count', label: 'Specimen count', kind: 'stat', query: { entity: 'specimens' }, aggregate: { fn: 'count' } },
    { id: 'recent', label: 'Recent specimens', kind: 'table', query: { entity: 'specimens', select: ['id', 'name', 'quantity'], limit: 5 }, columns: ['name', 'quantity'] },
  ] }], navigation: [{ id: 'neutral.summary', placement: 'sidebar', page: 'neutral.summary', label: 'Summary' }],
} } }
export function neutralConfig(second = false) {
  return defineInstance({ id: 'acme_neutral', revision: second ? 2 : 1, displayName: 'Neutral console', interactive: true,
    plugins: [identity, localAuth, organizations, members, legacyPermissions, consoleUI(), audit(), dashboard], roles: ['owner', 'viewer'],
    entities: {
      specimens: { displayField: 'name', fields: {
        name: { type: 'string', required: true }, note: { type: 'text' },
        quantity: { type: 'int', required: true, default: 0, min: 0 },
        secret: { type: 'string', sensitive: true, default: canary },
      } },
      ...(second ? { containers: { displayField: 'label', fields: { label: { type: 'string', required: true } } } } : {}),
    },
    permissions: { owner: { specimens: ['read', 'create', 'update', 'delete'], ...(second ? { containers: ['read', 'create', 'update', 'delete'] } : {}) }, viewer: { specimens: ['read'], ...(second ? { containers: [] } : {}) } },
    policies: { specimens: { owner: { where: {}, fields: ['name', 'note', 'quantity', 'version'] }, viewer: { where: {}, fields: ['name', 'quantity'] } }, ...(second ? { containers: { owner: 'all', viewer: 'all' } } : {}) },
    ui: { entities: { specimens: { list: { columns: ['name', 'quantity'] } } } },
  })
}
