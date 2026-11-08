// Trusted identity adapter only; never exported from the package entry point.
import { z } from 'zod'
import type { InstanceConfig } from './config'
import type { RuntimeEnv } from './types'
import type { GuardedStatement } from './execution/types'
import { coreExecutionContext } from './execution/context'
import { D1AtomicReader, D1AtomicStore } from './execution/d1'
import { executeAtomic } from './execution/atomic'
export async function identityWrite(env: RuntimeEnv, config: InstanceConfig, name: string, statements: GuardedStatement[], userId = 'identity-adapter') {
  const context = coreExecutionContext(config, { actor: { type: 'service', id: userId }, organizationId: '__identity__', role: '', correlationId: crypto.randomUUID() }, new D1AtomicStore(env.DB, { env, config }), new D1AtomicReader(env.DB))
  return executeAtomic({ name: `identity/${name}`, permission: { system: 'identity.write' }, input: z.strictObject({}), plan: () => ({
    rules: [{ name: `identity_${name}`, statements }], event: { operation: `identity.${name}`, entity: 'identities', entityId: userId }, result: { status: 200, body: {} },
  }) }, {}, context)
}
