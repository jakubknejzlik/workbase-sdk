import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { KernelRegistry } from '../kernel/registry'
import type { InstanceConfig } from '../config'
import { migrateD1 } from './d1-migrations'
import { httpD1Query } from './http-d1'
import { migrateInstance } from './instance-migrations'
import { readMigrationFiles } from './migration-files'
import { internalMigrationMessage, MigrationDiagnostic, redactCliOutput } from './diagnostics'

/** Config modules are trusted application code and must default-export an InstanceConfig. */
export async function runCli(args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  env = { ...env }
  const [command, database, directory, option, configPath, ...extra] = args
  const account = env.CLOUDFLARE_DEFAULT_ACCOUNT_ID; const token = env.CLOUDFLARE_API_TOKEN
  if (command !== 'migrate' || !database || !directory || !account || !token || extra.length ||
    (option !== undefined && (option !== '--config' || !configPath)) || (!option && configPath)) throw new MigrationDiagnostic({ code: 'usage' })
  const query = httpD1Query(account, database, token)
  // Load and validate configuration before the first database mutation.
  const config: InstanceConfig | undefined = configPath ? (await import(pathToFileURL(resolve(configPath)).href)).default : undefined
  if (configPath && !config) throw new MigrationDiagnostic({ code: 'invalid_config_default_export' })
  const kernel = config ? new KernelRegistry(config) : undefined
  const files = await readMigrationFiles(directory)
  const result = kernel ? await migrateInstance(query, files, kernel) : await migrateD1(query, files)
  console.log(redactCliOutput(JSON.stringify({ event: 'infra.migrations.applied', database, ...result }), env))
  return result
}

/** Only branded internal diagnostics carry text; external errors get a fixed class label. */
export function migrationErrorMessage(error: unknown, env: NodeJS.ProcessEnv = process.env): string {
  let message = internalMigrationMessage(error)
  if (message === undefined) {
    let name = 'UnknownError'
    try {
      // Never read an external error's message, name, code, cause or stack.
      for (const type of [TypeError, RangeError, SyntaxError, ReferenceError, URIError, EvalError, AggregateError, Error]) {
        if (error instanceof type) { name = type.name; break }
      }
    } catch { /* A thrown Proxy may also reject prototype inspection. */ }
    message = `migration_failed:${name}`
  }
  return redactCliOutput(message, env)
}
