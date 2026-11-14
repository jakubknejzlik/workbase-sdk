import type { Input } from '@pulumi/pulumi'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { SchemaRevision } from '../schema-compatibility'
import { migrationHash, readMigrationFiles, sha256 } from './migration-files'
import { ProvisionDiagnostic, provisionFailure } from './provision-diagnostics'
import { installedInfraDirectory } from './package-tools'
import { provisionConfigSchema } from './provision-config'

export interface ProvisionOptions {
  /** Trusted application module, default-exporting an InstanceConfig. Paths resolve from projectRoot. */
  configPath: string
  handler: string
  migrationsDir: string
  resourcePrefix: string
  stage: string
  /** Prebuilt console directory. Omit for an API-only Worker. */
  assetsDir?: string
  /** Stable, operator-supplied secret, e.g. new sst.Secret('AuthSecret').value. Never generated per deploy. */
  authSecret: Input<string>
  /** Exact public HTTPS origin; passed as AUTH_BASE_URL. */
  authBaseUrl: string
  domain?: string
  email?: { from: string }
  webhook?: { url: Input<string>; allowedHosts: Input<string>; service?: Input<string>; events?: string }
  internalToken?: Input<string>
  /** Secret OPS_TOKEN for protected operations; takes precedence over INTERNAL_TOKEN. */
  opsToken?: Input<string>
  /** Defaults to CLOUDFLARE_DEFAULT_ACCOUNT_ID. Credentials stay in the deploy environment. */
  accountId?: string
  /** Defaults to the SST app root (process.cwd() inside SST run()). */
  projectRoot?: string
  /** Defaults to true for production. Also set the SST app's removal/protect policy. */
  protect?: boolean
  /** Extra fingerprints for application/plugin verification hooks imported by configPath. */
  migrationTriggers?: Input<unknown>[]
}

export interface ProvisionPlan {
  stage: string
  root: string
  configPath: string
  handler: string
  migrationsDir: string
  assetsDir?: string
  names: { database: string; audit: string; events: string; deadLetter: string; worker: string }
  /** Stable Pulumi logical-name prefix, scoped to this instance and stage. */
  id: string
  schema: SchemaRevision
  environment: Record<string, string>
  bindingNames: string[]
  migration: { command: string; bin: string; triggers: string[] }
}

function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0') }
function label(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length <= limit && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)
}

/** No values supplied by callers are included in validation messages. */
export function validateProvisionOptions(options: ProvisionOptions): void {
  if (!options || !label(options.stage, 32)) throw new ProvisionDiagnostic('provision_invalid_stage')
  if (!label(options.resourcePrefix, 63)) throw new ProvisionDiagnostic('provision_invalid_prefix')
  if (!nonempty(options.handler)) throw new ProvisionDiagnostic('provision_invalid_handler')
  if (!nonempty(options.configPath)) throw new ProvisionDiagnostic('provision_invalid_config_path')
  if (!nonempty(options.migrationsDir)) throw new ProvisionDiagnostic('provision_invalid_migrations_dir')
  if (options.assetsDir !== undefined && !nonempty(options.assetsDir)) throw new ProvisionDiagnostic('provision_invalid_assets_dir')
  if (!options.authSecret || (typeof options.authSecret === 'string' && options.authSecret.length < 32)) throw new ProvisionDiagnostic('provision_invalid_auth_secret')
  try {
    const url = new URL(options.authBaseUrl)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw 0
    if (options.domain !== undefined && (url.hostname !== options.domain || !options.domain.includes('.') || url.port)) throw new ProvisionDiagnostic('provision_invalid_domain')
  } catch (error) {
    if (error instanceof ProvisionDiagnostic) throw error
    throw new ProvisionDiagnostic('provision_invalid_auth_base_url')
  }
  if (options.email && !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(options.email.from)) throw new ProvisionDiagnostic('provision_invalid_email')
  if (options.webhook && (!options.webhook.url || !options.webhook.allowedHosts)) throw new ProvisionDiagnostic('provision_invalid_webhook')
  if (options.accountId !== undefined && !/^[a-f0-9]{32}$/.test(options.accountId)) throw new ProvisionDiagnostic('provision_invalid_account_id')
}

/** Deterministic names fit SST's 54-character Worker limit and Cloudflare's 63-character queue limit.
 * The tuple hash disambiguates prefix/stage boundaries and truncated names. */
function resourceName(prefix: string, stage: string, suffix: string) {
  const hash = sha256(JSON.stringify([prefix, stage, suffix])).slice(0, 12)
  const stem = `${prefix}-${stage}-${suffix}`
  const limit = suffix === 'worker' ? 54 : 63
  return `${stem.slice(0, limit - hash.length - 1).replace(/-+$/, '')}-${hash}`
}

// SST bundles the program, so import.meta.url is then the bundle, not this source file.
// Resolve the installed package export rather than constructing paths relative to the bundle.
async function packageTools() {
  const infra = installedInfraDirectory()
  const source = dirname(infra)
  async function fingerprint(directory: string): Promise<string[]> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    return (await Promise.all(entries.map(async entry => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? fingerprint(path) : /\.(?:ts|mjs)$/.test(entry.name) ? [sha256(await readFile(path, 'utf8'))] : []
    }))).flat()
  }
  return { bin: join(infra, 'bin.mjs'), hash: sha256(JSON.stringify(await fingerprint(source))) }
}

/** Build a secret-free resource specification, without SST, Pulumi execution, preview or network access.
 * Config modules are trusted code, evaluated in an isolated Node process with tsx. */
export async function createProvisionPlan(options: ProvisionOptions): Promise<ProvisionPlan> {
  validateProvisionOptions(options)
  const root = resolve(options.projectRoot ?? process.cwd())
  const configPath = resolve(root, options.configPath), handler = resolve(root, options.handler)
  const migrationsDir = resolve(root, options.migrationsDir)
  const assetsDir = options.assetsDir === undefined ? undefined : resolve(root, options.assetsDir)
  try {
    if (!(await stat(handler)).isFile() || !(await stat(configPath)).isFile() || !(await stat(migrationsDir)).isDirectory() || (assetsDir && !(await stat(assetsDir)).isDirectory())) throw 0
  } catch { throw new ProvisionDiagnostic('provision_inputs_unreadable') }
  const secrets = [options.authSecret, options.internalToken, options.opsToken, options.webhook?.url, options.webhook?.allowedHosts, options.webhook?.service]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
  const schema = await provisionConfigSchema(root, configPath, migrationsDir, secrets)
  try {
    // Older consumers without the artifact retain provisioning; live verification fails closed.
    let openapi = 'unbuilt'
    try { openapi = createHash('sha256').update(await readFile(join(dirname(configPath), 'openapi.json'))).digest('hex') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const files = await readMigrationFiles(migrationsDir)
    const tools = await packageTools()
    const name = (suffix: string) => resourceName(options.resourcePrefix, options.stage, suffix)
    return {
      stage: options.stage, root, configPath, handler, migrationsDir, ...(assetsDir ? { assetsDir } : {}),
      names: { database: name('db'), audit: name('audit'), events: name('events'), deadLetter: name('events-dlq'), worker: name('worker') },
      id: `Workbase${sha256(JSON.stringify([options.resourcePrefix, options.stage])).slice(0, 20)}`,
      schema,
      environment: { STAGE: options.stage, SCHEMA_EXPECTED: JSON.stringify(schema), OPENAPI_SHA256: openapi, AUTH_BASE_URL: options.authBaseUrl,
        ...(options.email ? { EMAIL_FROM: options.email.from } : {}),
        ...(options.webhook?.events ? { WEBHOOK_EVENTS: options.webhook.events } : {}),
      },
      bindingNames: ['DB', 'AUDIT_KV', 'EVENTS_QUEUE', 'BETTER_AUTH_SECRET', 'AUTH_BASE_URL', 'STAGE', 'SCHEMA_EXPECTED', 'OPENAPI_SHA256',
        ...(assetsDir ? ['ASSETS'] : []), ...(options.email ? ['EMAIL', 'EMAIL_FROM'] : []),
        ...(options.webhook ? ['WEBHOOK_URL', 'WEBHOOK_ALLOWED_HOSTS', ...(options.webhook.service ? ['WEBHOOK_SERVICE'] : []), ...(options.webhook.events ? ['WEBHOOK_EVENTS'] : [])] : []),
        ...(options.internalToken ? ['INTERNAL_TOKEN'] : []),
        ...(options.opsToken ? ['OPS_TOKEN'] : []),
      ],
      migration: {
        command: '"$WB_NODE_BINARY" "$WB_MIGRATION_BIN" migrate "$WB_DATABASE_ID" "$WB_MIGRATIONS_DIRECTORY" --config "$WB_CONFIG_MODULE"',
        bin: tools.bin,
        triggers: [migrationHash(files), JSON.stringify(schema), tools.hash, sha256(await readFile(configPath, 'utf8'))],
      },
    }
  } catch (error) { throw provisionFailure(error) }
}
