import type { InstanceConfig } from './config'
import type { RuntimeEnv, Scope } from './types'
import { ApiError } from './errors'
import { kernelFor } from './kernel/registry'
import { executeQuery, type QueryLog } from './query/executor'
import { restQuery } from './query/facade'
import { cursorSecret } from './query/routes'

/** Detail GET authority, including credentials, hooks, ID mask and SQL read filters.
 * Action dispatch uses this before callbacks and again when normalizing errors.
 */
export async function readRecord(config: InstanceConfig, scope: Scope, env: RuntimeEnv, entity: string, id: string,
  params: Record<string, string> = {}, writeLog?: (log: QueryLog) => void) {
  if (!Object.hasOwn(config.entities, entity)) throw new ApiError(404, 'entity_not_found')
  const kernel = kernelFor(config)
  kernel.readPermission(scope, entity)
  const result = await executeQuery(kernel, scope, env.DB, await cursorSecret(env), restQuery(config, entity, params, id), { legacyErrors: true, writeLog })
  if (!result.data.length) throw new ApiError(404, 'not_found')
  return result.data[0]
}
