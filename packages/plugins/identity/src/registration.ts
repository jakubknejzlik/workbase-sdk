import type { ExternalIdentityAssertion } from '../../../core/src/kernel/identity-port'
import type { InstanceConfig } from '@workbasehq/core/config'
import type { RuntimeEnv } from '../../../core/src/types'
import { identityWrite } from '../../../core/src/identity-writes'

/** Internal bridge for the retained OAuth regression adapter: only the same
 * Better Auth call that just created the new local profile invokes this. This
 * creates a new identity, never pairs an existing local account by email. */
export async function recordExternalRegistration(env: RuntimeEnv, config: InstanceConfig, userId: string, external: ExternalIdentityAssertion) {
  await identityWrite(env, config, 'external_registered', [{
    sql: `INSERT INTO identities (user_id,provider,issuer,subject,created_at)
      SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM "user" WHERE id=?)
      AND NOT EXISTS (SELECT 1 FROM identities WHERE user_id=?)
      AND NOT EXISTS (SELECT 1 FROM "session" WHERE "userId"=?)`,
    bindings: [userId, external.provider, external.issuer, external.subject, new Date().toISOString(), userId, userId, userId], expectRows: 1,
  }], userId)
}
