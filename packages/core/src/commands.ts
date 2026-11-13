import { isAccountAccessCommand } from './worker-access-actions'
import { z } from 'zod'
import type { InstanceConfig } from './config'
import type { App, RuntimeEnv, Scope } from './types'
import { ApiError } from './errors'
import { kernelFor } from './kernel/registry'
import { operationName } from './kernel/operation-name'
import { executeAtomic, defineAtomicOperation } from './execution/atomic'
import { coreExecutionContext } from './execution/context'
import { D1AtomicStore, D1AtomicReader } from './execution/d1'
import type { AtomicOperation, AtomicResult } from './execution/types'
import { userLinkActionPermission } from './user-links'

/** Compatibility names for the existing registry and trusted direct dispatcher. */
export type CommandDefinition<S extends z.ZodType = z.ZodType> = AtomicOperation<S>
export type CommandRegistry = ReadonlyMap<string, CommandDefinition<any>>
export interface CommandContext { env: RuntimeEnv; config: InstanceConfig; scope: Scope; commands: CommandRegistry }
export const defineCommand = defineAtomicOperation
export function createCommandRegistry(definitions: readonly CommandDefinition<any>[]): CommandRegistry {
  const registry = new Map<string, CommandDefinition<any>>()
  for (const definition of definitions) {
    if (registry.has(definition.name)) throw new Error(`Duplicate command: ${definition.name}`)
    registry.set(definition.name, definition)
  }
  return registry
}
/** Shared entity-grant preflight. Atomic authorization follows with the actual input. */
export function commandPreflight(config: InstanceConfig, scope: Scope, operation: CommandDefinition) {
  if (!config.commands.includes(operation.name) || 'system' in operation.permission) throw new ApiError(405, 'unsupported_command')
  const kernel = kernelFor(config)
  for (const grant of [operation.permission, ...(operation.additionalPermissions ?? [])]) {
    kernel.commandGuard({ name: operationName(operation), kind: 'entity', permission: grant }, scope, undefined)
  }
  userLinkActionPermission(config, scope, operation)
}
/** Internal/trusted adapter compatibility. Never accept this context from request JSON. */
export async function executeCommand(ctx: CommandContext, name: string, input: unknown): Promise<AtomicResult> {
  // Card adapters require the record dispatcher's bound atomic guard.
  if (isAccountAccessCommand(ctx.config, name)) throw new ApiError(405, 'unsupported_command')
  const operation = ctx.commands.get(name)
  if (!operation) throw new ApiError(405, 'unsupported_command')
  commandPreflight(ctx.config, ctx.scope, operation)
  const raw = z.record(z.string(), z.unknown()).parse(typeof input === 'function' ? await input() : input)
  const { idempotencyKey, ...payload } = raw
  const key = z.string().min(1).max(128).optional().parse(idempotencyKey)
  const context = coreExecutionContext(ctx.config, ctx.scope, new D1AtomicStore(ctx.env.DB, { env: ctx.env, config: ctx.config }), new D1AtomicReader(ctx.env.DB), key)
  return executeAtomic(operation, payload, context)
}
export function commandRoutes(app: App, config: InstanceConfig, env: RuntimeEnv, commands: CommandRegistry) {
  app.post('/commands/*', async c => {
    const response = await executeCommand({ config, env, commands, scope: c.get('scope') }, c.req.path.slice('/commands/'.length), () => c.req.json())
    return c.json(response.body, response.status as any)
  })
}
