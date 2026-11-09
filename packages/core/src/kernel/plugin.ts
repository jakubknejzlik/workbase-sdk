import type { ConsoleContribution, ConsoleRegistry } from '../console-contract'
import type { IdentityPort, ProfileSynchronization } from './identity-port'
import type { MailOutboxPort } from './mail-outbox-port'
import type { AuditPort } from './audit-port'
import type { ZodType } from 'zod'
import type { InstanceConfig, InstanceInput, OrganizationAction } from '../config'
import type { CommandDefinition } from '../commands'
import type { WorkflowDefinition } from '../execution/workflow'
import type { AtomicOperation } from '../execution/types'
import type { AuditEvent } from '../audit-event'
import type { App, ResolvedActor, RuntimeEnv, Scope } from '../types'

/** Server-resolved constants only. Task 3 compiles policies/$actor into this contract. */
export type PredicateValue = string | number | boolean | null
export interface PredicateOperators {
  eq?: PredicateValue; ne?: PredicateValue; in?: readonly PredicateValue[]
  lt?: Exclude<PredicateValue, null>; lte?: Exclude<PredicateValue, null>
  gt?: Exclude<PredicateValue, null>; gte?: Exclude<PredicateValue, null>
  contains?: string; isNull?: boolean
}
/** Child field correlates to parentField on the current table; identifiers are server-owned. */
export interface PredicateRelation { entity: string; field: string; parentField: string; predicate: Predicate }
/** Trusted policy-only probe. Authority comes from the live server projection;
 * renderers recheck membership/account/token in the same statement as the row. */
export interface PredicateActorLink {
  entity: string; organizationId: string; accountId: string; membershipRole: string
  token?: { id: string; role: string }
}
export type Predicate = { all: readonly Predicate[] } | { any: readonly Predicate[] }
  | { not: Predicate } | { exists: PredicateRelation } | { notExists: PredicateRelation }
  | { actorLinkedIn: PredicateActorLink }
  /** Mandatory top-level conjunct emitted by the policy compiler. */
  | { actorAuthority: Omit<PredicateActorLink, 'entity'> }
  | { [field: string]: PredicateOperators }
export type TableFilter = ({ kind: 'all' } | { kind: 'none'; deny?: 'empty' | 'forbidden' } | { kind: 'where'; predicate: Predicate; deny?: 'empty' | 'forbidden' }) & {
  /** Mandatory request authority, independent of row selection and constant
   * folding. The final expanded compiler emits these as root conjuncts. */
  actorAuthorities?: readonly Omit<PredicateActorLink, 'entity'>[]
}
export type GuardResult = { allow: true } | { allow: false; code: string }
export type ResourceAction = OrganizationAction | 'audit.read' | 'workflows.read' | 'workflows.resume' | 'workflows.cancel'
/** Metadata only; no planning function, store or execution capability is exposed. */
export interface KernelCommand {
  name: string
  kind: 'entity' | 'command' | 'resource'
  permission: AtomicOperation['permission'] | { system: ResourceAction }
  additionalPermissions?: AtomicOperation['additionalPermissions']
}
export interface PluginMigration {
  name: string
  /** Immutable SQL or static identity, hashed in the append-only ledger. */
  sql: string
  /** Trusted schema-derived SQL; reads precede the atomic statements + receipt batch. */
  statements?: (db: D1Database) => Promise<readonly string[]>
}
export interface PluginMcpTool { name: string; description: string; inputSchema: ZodType }
export interface PluginContext { readonly config: InstanceConfig }
export interface WorkbasePlugin {
  name: string
  version: string
  /** Public contract majors, independent of the package version. */
  provides?: Readonly<Record<string, `${number}.x`>>
  requires?: Readonly<Record<string, `^${number}`>>
  optionalRequires?: Readonly<Record<string, `^${number}`>>
  /** Only the single permissions contract provider can enable authorization. */
  authorization?: boolean
  /** Stable local profile/mapping port, supplied by Identity only. */
  identity?: IdentityPort
  /** Profile synchronization policy declared by an external login adapter. */
  profileAuthority?: { provider: string; synchronization: ProfileSynchronization }
  mailOutbox?: MailOutboxPort
  audit?: AuditPort
  contributes?: { console?: ConsoleContribution }
  /** Console provider owns registry validation and actor projection. */
  validateConsole?(config: InstanceConfig): void
  consoleRegistry?(config: InstanceConfig, scope: Scope): ConsoleRegistry
  authenticate?(this: PluginContext, req: Request, env: RuntimeEnv): Promise<ResolvedActor | null> | ResolvedActor | null
  /** Runs only for the sole, Identity-validated login claimant. */
  synchronizeProfile?(this: PluginContext, req: Request, env: RuntimeEnv, actor: ResolvedActor): Promise<void>
  /** Optional Organizations port. A selector is never a membership grant. */
  resolveScopeId?(db: D1Database, selected?: string): Promise<string | null>
  /** Login owns provisional session issuance and revocation, never Members. */
  signInInvitation?(this: PluginContext, email: string, request: Request, env: RuntimeEnv): Promise<{ actor: ResolvedActor; response: Response; revoke: () => Promise<void> }>
  /** Canonical filters fully described by model policy/scope need no additional custom receipt. */
  policyInConfig?: true
  tableFilter?(this: PluginContext, entity: string, scope: Scope): TableFilter
  fieldMask?(this: PluginContext, entity: string, scope: Scope): readonly string[]
  commandGuard?(this: PluginContext, command: KernelCommand, scope: Scope, input: unknown): GuardResult
  /** Project plugin-owned configuration into the validated model's compatibility fields. */
  configuration?: unknown
  configure?(configuration: unknown): Partial<Pick<InstanceInput, 'roles' | 'organizationOwnerRole' | 'organizationPermissions'>>
  /** Credential authentication is independent of interactive login providers. */
  authenticateCredential?(this: PluginContext, req: Request, env: RuntimeEnv): Promise<ResolvedActor | null> | ResolvedActor | null
  /** Validates config.pluginConfig[name], including schema defaults/transforms. */
  configSchema?: ZodType
  /** Domain defaults materialized by defineInstance; explicit schema edits take precedence. */
  model?: Partial<Pick<InstanceInput, 'entities' | 'permissions' | 'policies' | 'ui' | 'account' | 'commands' | 'organizationPermissions'>>
  /** Bind workflow effects to this Worker environment without selecting a distribution. */
  workflowDefinitions?(env: RuntimeEnv): ReadonlyMap<string, WorkflowDefinition<any>>
  entities?: InstanceInput['entities']
  commands?: readonly CommandDefinition<any>[]
  workflows?: readonly WorkflowDefinition<any>[]
  migrations?: readonly PluginMigration[]
  /** Read-only structural verification against the effective instance model and applied ledger. */
  checkSchema?(db: D1Database, config: Pick<InstanceConfig, 'entities'>): Promise<void>
  /** Read-only verification of additional bindings at the deployed compatibility gate. */
  checkEnvironment?(env: { DB: D1Database; AUDIT_KV?: KVNamespace }): Promise<void>
  routes?(this: PluginContext, app: App, config: InstanceConfig, env: RuntimeEnv): void
  mcpTools?(this: PluginContext): readonly PluginMcpTool[]
  onEvent?(this: PluginContext, event: AuditEvent): void | Promise<void>
}
