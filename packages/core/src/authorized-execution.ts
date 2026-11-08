import { kernelFor } from './kernel/registry'
import type { InstanceConfig } from './config'
import type { RuntimeEnv } from './types'
import { requireScope } from './authorization'
import { executeCommand, type CommandRegistry } from './commands'
/** Entry point for MCP/internal adapters. Identity/org inputs are selectors, never authority.
 * Resolve on EVERY execution, including replay; never retain a previous scope or client role.
 * executeCommand is the lower-level trusted pipeline; adapters must use this boundary.
 */
export async function executeAuthorized(request: Request, env: RuntimeEnv, config: InstanceConfig, commands: CommandRegistry, organizationId: string, name: string, input: unknown) {
  const actor = await kernelFor(config).requireActor(request, env)
  const correlation = request.headers.get('X-Correlation-Id')
  const scope = await requireScope(actor, organizationId, config, correlation && /^[a-zA-Z0-9_-]{1,100}$/.test(correlation) ? correlation : undefined, name)
  return executeCommand({ env, config, commands, scope }, name, input)
}
