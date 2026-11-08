import type { InstanceConfig } from '@workbasehq/core/config'
import type { RuntimeEnv } from '../../../core/src/types'
import { createIdentityAuth } from './better-auth'
import { kernelFor } from '@workbasehq/core/kernel/registry'

/** A newly issued session becomes usable only after the kernel accepts it. */
export async function authenticateIssuedSession(bearer: string, url: string, env: RuntimeEnv, config: InstanceConfig, newlyIssued = true) {
  try {
    return await kernelFor(config).requireActor(new Request(url, { headers: { Authorization: `Bearer ${bearer}` } }), env)
  } catch (error) {
    if (newlyIssued) await revokeIssuedSession(bearer, env, config)
    throw error
  }
}

/** Best-effort cleanup must preserve the original authentication/acceptance error. */
export async function revokeIssuedSession(bearer: string, env: RuntimeEnv, config: InstanceConfig) {
  try { await createIdentityAuth(env, config, false, false).api.signOut({ headers: new Headers({ Authorization: `Bearer ${bearer}` }) }) } catch {}
}
