import { accessGuards } from '../access-guards'
import { isBuiltinPlugin } from './builtin-source'
import { baseFields, defineInstance, normalizeInstance, type InstanceConfig, type InstanceInput, type Operation } from '../config'
import { createCommandRegistry, type CommandRegistry } from '../commands'
import { createWorkflowRegistry, type WorkflowRegistry } from '../workflow-runtime'
import { authorizeOperation } from '../authorization'
import { operationName } from './operation-name'
import { ApiError } from '../errors'
import type { App, ResolvedActor, RuntimeEnv, RuntimeOptions, Scope } from '../types'
import type { AuditEvent } from '../audit-event'
import type { AtomicOperation } from '../execution/types'
import type { KernelCommand, ResourceAction, PluginMigration, Predicate, TableFilter, WorkbasePlugin } from './plugin'
import { renderPredicate } from './predicate'
export { renderPredicate } from './predicate'
import { schemaConfigs, DeclarationError } from '../schema/declaration'
import { resolvePlugins } from './composition'
import { applyPluginMigrations } from './migrations'
import { timed } from '../request-timing'
import { policyFilter, readableFields, validatePolicies } from '../policies'
import { effectiveAuthority } from '../access-evaluator'
import { userLinkCommands, userLinkActionPermission } from '../user-links'

const registries = new WeakMap<InstanceConfig, KernelRegistry>()
export const lifecyclePhases = ['contribute', 'validate', 'migrations', 'ports', 'mount'] as const
export class KernelRegistry {
  readonly plugins: readonly WorkbasePlugin[]
  readonly providers: ReadonlyMap<string, readonly WorkbasePlugin[]>
  readonly config: InstanceConfig
  readonly commands: CommandRegistry
  readonly workflows: WorkflowRegistry
  readonly migrations: readonly PluginMigration[]
  /** True only for a complete permissions provider outside development trust. */
  readonly permissionsActive: boolean
  private readonly trust: boolean
  private readonly hasAuthorization: boolean
  constructor(config: InstanceInput & Pick<InstanceConfig, 'effectiveAccess'>, options: RuntimeOptions = {}, env?: RuntimeEnv) {
    if (schemaConfigs.has(config) && !config.effectiveAccess) throw new DeclarationError(['access'], 'Executable schema configurations require explicit entity access and shared access.ts')
    const resolved = resolvePlugins(options.plugins ?? config.plugins ?? [], config.interactive)
    this.plugins = resolved.plugins
    this.providers = resolved.providers
    const names = new Set(this.plugins.map(plugin => plugin.name))
    // contribute: reject collisions rather than allowing load order to silently overwrite code.
    const entities = { ...config.entities }
    const commands = [...(options.commands?.values() ?? [])]
    const workflows = [...(options.workflows?.values() ?? [])]
    const commandNames = [...(config.commands ?? [])]
    for (const plugin of this.plugins) {
      for (const [name, entity] of Object.entries(plugin.entities ?? {})) {
        if (Object.hasOwn(entities, name)) throw new Error(`Duplicate entity: ${name}`)
        entities[name] = entity
      }
      for (const command of plugin.commands ?? []) {
        if (!isBuiltinPlugin(plugin) || !options.commands?.has(command.name)) commands.push(command)
        if (!commandNames.includes(command.name)) commandNames.push(command.name)
      }
      for (const workflow of [...(plugin.workflows ?? []), ...(env ? plugin.workflowDefinitions?.(env)?.values() ?? [] : [])]) {
        if (!isBuiltinPlugin(plugin) || !options.workflows?.has(workflow.name)) workflows.push(workflow)
      }
    }
    // validate: whole model, registries, and each plugin-owned section.
    const pluginConfig = { ...config.pluginConfig }
    for (const plugin of this.plugins) if (plugin.configSchema) pluginConfig[plugin.name] = plugin.configSchema.parse(pluginConfig[plugin.name])
    for (const name of Object.keys(pluginConfig)) if (!names.has(name)) throw new Error(`Unknown plugin config: ${name}`)
    const normalize = config.effectiveAccess ? (input: Parameters<typeof normalizeInstance>[0]) => normalizeInstance(input, true) : defineInstance
    this.config = normalize({ ...config, plugins: this.plugins, entities, commands: commandNames,
      ...(config.pluginConfig || Object.keys(pluginConfig).length ? { pluginConfig } : {}) })
    // Preserve slice-1 declaration identity across the kernel's normalized copy.
    if (schemaConfigs.has(config)) schemaConfigs.add(this.config)
    if (config.effectiveAccess) { this.config.effectiveAccess = config.effectiveAccess; validatePolicies(this.config) }
    this.providers.get('console')?.[0]?.validateConsole?.(this.config)
    for (const command of userLinkCommands(this.config)) {
      commands.push(command)
      if (!this.config.commands.includes(command.name)) this.config.commands.push(command.name)
    }
    this.commands = createCommandRegistry(commands)
    this.workflows = createWorkflowRegistry(workflows)
    if (this.config.effectiveAccess) this.config.effectiveAccess = accessGuards(this.config.effectiveAccess, this.config.commands, [...this.commands.values()], this.plugins)
    // migrations: append hooks to the supplied chain. Applying D1 migrations remains an operator action.
    this.migrations = Object.freeze([...(options.migrations ?? []), ...this.plugins.flatMap(plugin => (plugin.migrations ?? []).map(migration => ({ ...migration, name: `${plugin.name}/${migration.name}` })))])
    if (new Set(this.migrations.map(migration => migration.name)).size !== this.migrations.length) throw new Error('Duplicate plugin migration')
    // ports: only complete validated configuration becomes visible to request helpers.
    this.trust = options.authorization === 'trust'
    this.hasAuthorization = this.providers.has('permissions')
    this.permissionsActive = !this.trust && this.hasAuthorization
    if (this.trust) console.warn('Workbase kernel: authorization=trust enabled (development only)')
    registries.set(this.config, this)
  }
  get identity() {
    const port = this.providers.get('identity')?.[0]?.identity
    if (!port) throw new ApiError(401, 'identity_port_required')
    return port
  }
  get mailOutbox() {
    const port = this.providers.get('mail-outbox')?.[0]?.mailOutbox
    if (!port) throw new ApiError(503, 'mail_outbox_required')
    return port
  }
  get audit() { return this.providers.get('audit')?.[0]?.audit }
  /** Explicit operator action; never run migrations in a request or on uninstall. */
  applyMigrations(db: D1Database) { return applyPluginMigrations(db, this.plugins, this.config) }
  async resolveScopeId(db: D1Database, selected?: string): Promise<string> {
    const provider = this.providers.get('organizations')?.[0]
    if (!provider) {
      if (!this.providers.has('members')) {
        if (!selected) throw new ApiError(403, 'organization_required')
        return selected
      }
      if (selected && selected !== 'instance') throw new ApiError(403, 'organization_forbidden')
      return 'instance'
    }
    // Compatibility tenancy supplies no new scope port during extraction.
    const scope = provider.resolveScopeId ? await provider.resolveScopeId(db, selected) : selected
    if (!scope) throw new ApiError(403, 'organization_required')
    return scope
  }
  async signInInvitation(email: string, request: Request, env: RuntimeEnv) {
    const providers = (this.providers.get('login') ?? []).filter(plugin => plugin.signInInvitation)
    if (providers.length !== 1) throw new ApiError(401, 'invitation_login_required')
    return providers[0].signInInvitation!.call(this, email, request, env)
  }
  mount(app: App, env: RuntimeEnv) {
    for (const plugin of this.plugins) plugin.routes?.call(this, app, this.config, env)
  }
  mcpTools() { return this.plugins.flatMap(plugin => plugin.mcpTools?.call(this) ?? []) }
  async onEvent(event: AuditEvent) {
    for (const plugin of this.plugins) await plugin.onEvent?.call(this, event)
  }
  async authenticate(request: Request, env: RuntimeEnv): Promise<ResolvedActor | null> {
    let claimed: ResolvedActor | null = null
    let login: WorkbasePlugin | undefined
    for (const plugin of this.plugins) {
      for (const authenticate of [plugin.authenticate, plugin.authenticateCredential]) {
        const actor = await authenticate?.call(this, request, env)
        if (!actor) continue
        if (claimed) throw new ApiError(401, 'ambiguous_login')
        claimed = actor
        login = authenticate === plugin.authenticate ? plugin : undefined
      }
    }
    if (claimed?.actor.type === 'user' && !claimed.user) throw new ApiError(401, 'invalid_local_identity')
    if (claimed?.user) {
      if (claimed.actor.type !== 'user' || claimed.actor.id !== claimed.user.id) throw new ApiError(401, 'invalid_local_identity')
      const local = await this.identity.resolveUser(env.DB, claimed.user.id)
      if (local.email.toLowerCase() !== claimed.user.email.toLowerCase()) throw new ApiError(401, 'invalid_local_identity')
      await login?.synchronizeProfile?.call(this, request, env, claimed)
    }
    return claimed // anonymous; scoped surfaces require a verified actor.
  }
  async requireActor(request: Request, env: RuntimeEnv): Promise<ResolvedActor> {
    return timed('auth', async () => {
      const actor = await this.authenticate(request, env)
      if (!actor) throw new ApiError(401, 'unauthenticated')
      return actor
    })
  }
  tableFilter(entity: string, scope: Scope, operation: Operation = 'read'): TableFilter {
    if (!this.trust && !this.hasAuthorization) return { kind: 'none' }
    // The compiled policy is mandatory regardless of the permissions provider.
    // Its builtin adapter would duplicate it and use the default read operation.
    const filters = this.plugins.flatMap(plugin => plugin.tableFilter && !(this.config.effectiveAccess && isBuiltinPlugin(plugin) && plugin.authorization && plugin.policyInConfig) ? [plugin.tableFilter.call(this, entity, scope)] : [])
    if (this.config.effectiveAccess) filters.unshift(policyFilter(this.config, entity, scope, operation))
    if (!filters.length) return { kind: this.trust ? 'all' : 'none' }
    // A denying provider may erase row selection, but never request authority
    // needed by an enclosing policy that negates this source's existence.
    const actorAuthorities = filters.flatMap(filter => filter.actorAuthorities ?? [])
    const authority = actorAuthorities.length ? { actorAuthorities } : {}
    if (filters.some(filter => filter.kind === 'none')) return { kind: 'none', ...authority, ...(filters.some(filter => 'deny' in filter && filter.deny === 'forbidden') ? { deny: 'forbidden' as const } : {}) }
    const where = filters.filter((filter): filter is Extract<TableFilter, { kind: 'where' }> => filter.kind === 'where')
    return where.length ? { kind: 'where', predicate: { all: where.map(filter => filter.predicate) }, ...authority, ...(where.some(filter => filter.deny === 'forbidden') ? { deny: 'forbidden' as const } : {}) } : { kind: 'all', ...authority }
  }
  fieldMask(entity: string, scope: Scope): string[] {
    let fields = this.config.effectiveAccess ? readableFields(this.config, entity, scope) : [...baseFields, ...Object.keys(this.config.entities[entity].fields)]
    for (const plugin of this.plugins) if (plugin.fieldMask) {
      const mask = new Set(plugin.fieldMask.call(this, entity, scope))
      fields = fields.filter(field => mask.has(field))
    }
    return fields
  }
  commandGuard(command: KernelCommand, scope: Scope, input: unknown) {
    // Only the existing trusted identity writer can use this service permission.
    const internal = scope.actor.type === 'service' && 'system' in command.permission && command.permission.system === 'identity.write'
    if (!internal && !this.trust && !this.hasAuthorization) throw new ApiError(403, 'permission_denied')
    // Credential restrictions and entity-scope provenance survive provider removal and trust.
    if (scope.actor.type === 'agent' || command.kind === 'entity') authorizeOperation(scope, operationName(command))
    if (this.config.effectiveAccess && !internal) {
      const policy = this.config.effectiveAccess
      const authority = effectiveAuthority(policy, scope)
      const primary = command.permission
      if (command.kind === 'command') {
        const guard = policy.guards.find(guard => guard.name === command.name)
        if (!guard?.permission && !('system' in primary)) throw new ApiError(405, 'unsupported_command')
        const requirements = guard?.permission ? [guard.permission, ...guard.additionalPermissions] : []
        for (const grant of requirements) if (!authority.permits(grant)) throw new ApiError(403, 'permission_denied')
      }
      if (!authority.permits(primary)) throw new ApiError(403, 'permission_denied')
      for (const grant of command.additionalPermissions ?? []) if (!authority.permits(grant)) throw new ApiError(403, 'permission_denied')
    }
    for (const plugin of this.plugins) {
      if (this.config.effectiveAccess && isBuiltinPlugin(plugin) && plugin.authorization && plugin.policyInConfig) continue
      const result = plugin.commandGuard?.call(this, command, scope, input)
      if (result && !result.allow) throw new ApiError(403, result.code)
    }
  }
  resourcePermission(scope: Scope, action: ResourceAction) {
    this.commandGuard({ name: operationName({ system: action }), kind: 'resource', permission: { system: action } }, scope, undefined)
  }
  permission(scope: Scope, entity: string, operation: Operation) {
    this.commandGuard({ name: operationName({ entity, operation }), kind: 'entity', permission: { entity, operation } }, scope, undefined)
  }
  /** Only use when the caller compiles tableFilter into every table reference. */
  readPermission(scope: Scope, entity: string) {
    if (!this.trust && !this.hasAuthorization) return
    this.permission(scope, entity, 'read')
  }
  can(scope: Scope, entity: string, operation: Operation) {
    if (operation === 'read' && (this.tableFilter(entity, scope).kind === 'none' || !this.fieldMask(entity, scope).includes('id'))) return false
    try { this.permission(scope, entity, operation); return true } catch (error) { if (error instanceof ApiError && error.status === 403) return false; throw error }
  }
  atomicPermission(scope: Scope, operation: AtomicOperation, input?: unknown) {
    this.commandGuard({ name: operationName(operation), kind: 'command', permission: operation.permission, additionalPermissions: operation.additionalPermissions }, scope, input)
    userLinkActionPermission(this.config, scope, operation)
  }
}
/** Request and execution helpers only accept a validated, explicitly bound composition. */
export function boundKernel(config: InstanceConfig): KernelRegistry | undefined { return registries.get(config) }
export function kernelFor(config: InstanceConfig): KernelRegistry {
  const registry = boundKernel(config)
  if (!registry) throw new Error('Unbound instance config: construct KernelRegistry and use kernel.config')
  return registry
}
/** Preserve the selected ports across immutable execution-context config snapshots. */
export function bindKernel(source: InstanceConfig, target: InstanceConfig) { registries.set(target, kernelFor(source)) }
export function filterSql(filter: TableFilter, tableAlias: string): { sql: string; bindings: unknown[] } {
  if (filter.actorAuthorities?.length) {
    const row: Predicate = filter.kind === 'where' ? filter.predicate : filter.kind === 'all' ? { all: [] } : { any: [] }
    return renderPredicate({ all: [...filter.actorAuthorities.map(actorAuthority => ({ actorAuthority })), row] }, tableAlias)
  }
  return filter.kind === 'where' ? renderPredicate(filter.predicate, tableAlias) : { sql: filter.kind === 'all' ? '1=1' : '0=1', bindings: [] }
}
