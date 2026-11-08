import type { AuditOutboxRow } from './kernel/audit-port'
import type { WorkbasePlugin, PluginMigration } from './kernel/plugin'
import type { WorkflowRegistry } from './workflow-runtime'
import type { SchemaEnvironment } from './schema-compatibility'
import type { Context, Hono } from 'hono'
import type { InstanceConfig } from './config'
import type { CommandRegistry } from './commands'
export interface EmailEnvironment { EMAIL?: SendEmail; EMAIL_FROM?: string }
export interface IdentitySettings {
  baseURL: string; secret: string
  localPassword?: boolean
  oidc?: { issuer: string; clientId: string; clientSecret: string }
}
export interface RuntimeEnv extends SchemaEnvironment, EmailEnvironment { CONFIG_EDITOR_URL?: string; CONFIG_EDITOR_TOKEN?: string; ASSETS?: Fetcher; BUILD_SHA?: string; BUILD_AT?: string; AUTH_BASE_URL?: string; BETTER_AUTH_SECRET?: string; OIDC_ISSUER?: string; OIDC_CLIENT_ID?: string; OIDC_CLIENT_SECRET?: string; DEV_LOCAL_IDENTITY?: string; IDENTITY?: IdentitySettings; DB: D1Database; AUDIT_KV: KVNamespace; EVENTS_QUEUE?: Queue<AuditOutboxRow>; INTERNAL_TOKEN?: string; WEBHOOK_URL?: string; WEBHOOK_EVENTS?: string; WEBHOOK_ALLOWED_HOSTS?: string; WEBHOOK_SERVICE?: Fetcher }
export type { ResolvedActor } from './authorization'
import type { ResolvedActor } from './authorization'
export type { Actor, Scope } from './identity'
import type { Scope } from './identity'
export type AppEnv = { Variables: { scope: Scope; resolvedActor: ResolvedActor; userId: string; correlationId: string } }
export type App = Hono<AppEnv>
export type AppContext = Context<AppEnv>
export interface RuntimeOptions {
  plugins?: readonly WorkbasePlugin[]
  /** Explicit development bypass; never inferred from environment. */
  authorization?: 'trust'
  migrations?: readonly PluginMigration[]
  workflows?: WorkflowRegistry
  commands?: CommandRegistry
  extend?: (app: App, config: InstanceConfig, env: RuntimeEnv) => void
}
