import { migrations } from './migrations/index'
import { builtinPlugin } from '@workbasehq/core/kernel/builtin-source'
import { sealActor } from '../../../core/src/authorization'
import { assertIdentityTransport } from '../../../core/src/identity-settings'
import { kernelFor } from '@workbasehq/core/kernel/registry'
import { sha256 } from '@workbasehq/core/crypto'
import { ApiError } from '../../../core/src/errors'
import type { WorkbasePlugin } from '@workbasehq/core/kernel/plugin'
import { machineCredentialRoutes } from './routes'

const plugin: WorkbasePlugin = builtinPlugin({
  name: 'machine-credentials', version: '0.1.0', provides: { 'machine-credentials': '1.x' },
  requires: { identity: '^1', members: '^1', permissions: '^1' },
  optionalRequires: { console: '^1' },
  contributes: { console: {
    pages: [{ id: 'machine-credentials.tokens', path: '/settings/api-tokens', label: 'tokens', grant: 'tokens.read', renderer: 'machine-credentials.tokens' }],
    navigation: [{ id: 'machine-credentials.tokens', placement: 'settings', page: 'machine-credentials.tokens', label: 'tokens', order: 40, grant: 'tokens.read' }],
  } },
  // Adopt the existing table unchanged. Staging-applied legacy chains remain immutable.
  migrations,
  async checkSchema(db) {
    await db.prepare('SELECT id,organization_id,issuer_id,token_hash,role,operations,revoked_at,expires_at FROM access_tokens LIMIT 0').all()
    const index = await db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='access_tokens_live_issuer'").first()
    if (!index) throw new Error('machine_credentials_schema_missing')
  },
  async authenticateCredential(request, env) {
    const authorization = request.headers.get('Authorization')
    if (!authorization?.startsWith('Bearer wb_')) return null
    assertIdentityTransport(request)
    const hash = await sha256(authorization.slice(7))
    const row = await env.DB.prepare(`SELECT t.id,t.organization_id,t.role,o.name FROM access_tokens t
      JOIN organizations o ON o.id=t.organization_id WHERE t.token_hash=? AND t.revoked_at IS NULL AND t.expires_at>?`)
      .bind(hash, new Date().toISOString()).first<{ id: string; organization_id: string; role: string; name: string }>()
    if (!row) throw new ApiError(401, 'unauthenticated')
    if (!kernelFor(this.config).providers.has('organizations') && row.organization_id !== 'instance') throw new ApiError(403, 'organization_forbidden')
    return sealActor({ actor: { type: 'agent', id: row.id, tokenId: row.id }, user: null,
      organizations: [{ id: row.organization_id, name: row.name, role: row.role }],
    }, { env, hash })
  },
  routes: machineCredentialRoutes,
})
/** Independent of Local Auth; headless and IdP-only compositions use the same credentials. */
export function machineCredentials(): WorkbasePlugin { return plugin }
