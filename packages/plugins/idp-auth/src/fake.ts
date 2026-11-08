import type { WorkbasePlugin } from '@workbasehq/core/kernel/plugin'
import type { ExternalIdentityAssertion } from '../../../core/src/kernel/identity-port'
import { kernelFor } from '@workbasehq/core/kernel/registry'
import { sealActor, type AvailableOrganization } from '../../../core/src/authorization'
import { assertIdentityTransport } from '../../../core/src/identity-settings'
import { ApiError } from '../../../core/src/errors'
import { schemaStatus } from '@workbasehq/core/schema-compatibility'

import type { IdpAdapter } from './index'

/** In-memory fake credentials are issued by test/dev code, never by an HTTP endpoint. */
export class FakeIdpAdapter implements IdpAdapter {
  readonly id = 'fake'
  readonly synchronization = { method: 'login', maxLatencySeconds: 0 }
  private readonly credentials = new Map<string, ExternalIdentityAssertion>()
  issue(identity: ExternalIdentityAssertion, token = `fake_${crypto.randomUUID()}`) {
    this.credentials.set(token, Object.freeze({ ...identity }))
    return token
  }
  revoke(token: string) { this.credentials.delete(token) }
  async authenticate(request: Request) { return this.credentials.get(request.headers.get('X-Fake-Idp-Token') ?? '') ?? null }
  async isActive(request: Request, identity: ExternalIdentityAssertion) { return await this.authenticate(request) === identity }
}
/** Contract plus fake only: there is deliberately no real IdP implementation. */
export function idpAuth(options: { mode: 'test' | 'development'; adapter: FakeIdpAdapter }): WorkbasePlugin {
  if (!['test', 'development'].includes(options.mode) || !(options.adapter instanceof FakeIdpAdapter)) throw new Error('idp-auth requires an explicit test/development fake adapter')
  const adapter: IdpAdapter = options.adapter
  return {
    name: 'idp-auth', version: '0.1.0', provides: { login: '1.x' }, requires: { identity: '^1' },
    profileAuthority: { provider: adapter.id, synchronization: adapter.synchronization },
    async authenticate(request, env) {
      if ((env.STAGE && env.STAGE !== 'local') || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(request.url).hostname)) throw new ApiError(503, 'fake_idp_not_allowed')
      const external = await adapter.authenticate(request)
      if (!external) return null
      assertIdentityTransport(request)
      const kernel = kernelFor(this.config)
      const user = await kernel.identity.resolveExternalIdentity(env.DB, external)
      let organizations = (await env.DB.prepare('SELECT o.id,o.name,m.role FROM memberships m JOIN organizations o ON o.id=m.organization_id WHERE m.user_id=?').bind(user.id).all<AvailableOrganization>()).results
      if (!kernel.providers.has('organizations')) organizations = organizations.filter(org => org.id === 'instance')
      const valid = async () => {
        if (!await adapter.isActive(request, external)) return false
        try {
          const current = await kernel.identity.resolveExternalIdentity(env.DB, external)
          return current.id === user.id && current.email === user.email
        } catch { return false }
      }
      return sealActor({ actor: { type: 'user', id: user.id }, user, organizations }, { env, hash: '',
        session: { recipientVerification: 'provider', valid,
          verified: async () => external.emailVerified === true && external.email.toLowerCase() === user.email.toLowerCase() && await valid(),
        },
      })
    },
    async synchronizeProfile(request, env, actor) {
      const external = await adapter.authenticate(request)
      if (!external || !await adapter.isActive(request, external)) throw new ApiError(401, 'unauthenticated')
      if (external.firstName === undefined && external.lastName === undefined) return
      if (!(await schemaStatus(env, this.config)).compatible) throw new ApiError(503, 'schema_mismatch')
      const kernel = kernelFor(this.config)
      if ((await kernel.identity.resolveExternalIdentity(env.DB, external)).id !== actor.user?.id) throw new ApiError(401, 'invalid_local_identity')
      await kernel.identity.syncProfile(env, this.config, external, { firstName: external.firstName!, lastName: external.lastName! })
    },
    routes(app) {
      app.get('/auth/providers', c => c.json({ providers: [{ id: adapter.id }] }))
    },
  }
}
