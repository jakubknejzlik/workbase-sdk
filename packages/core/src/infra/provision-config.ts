import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { SchemaRevision } from '../schema-compatibility'
import { installedInfraDirectory } from './package-tools'
import { ProvisionDiagnostic } from './provision-diagnostics'

type Result = { kind: 'schema'; schema: SchemaRevision }
  | { kind: 'load-error'; message: string }
  | { kind: 'invalid-config' | 'schema-error' }

/** SST registers process-wide ESM hooks. Evaluate trusted project code outside
 * that process, without inheriting execArgv or NODE_OPTIONS loader registrations.
 * stdout/stderr are discarded: config logs must not expose secrets or break IPC. */
export async function provisionConfigSchema(root: string, configPath: string, migrationsDirectory: string, secrets: string[]): Promise<SchemaRevision> {
  const result = await new Promise<Result>((resolve, reject) => {
    const child = spawn(process.execPath, [join(installedInfraDirectory(), 'provision-config-main.mjs'), configPath, migrationsDirectory], {
      cwd: root, env: { ...process.env, NODE_OPTIONS: '' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    let result: Result | undefined
    const timeout = setTimeout(() => { child.kill('SIGKILL') }, 30000)
    child.on('message', message => { result = message as Result })
    child.on('error', error => { clearTimeout(timeout); reject(error) })
    child.on('close', code => {
      clearTimeout(timeout)
      if (code === 0 && result) resolve(result)
      else reject(new Error(code === null ? 'Config evaluation timed out or was terminated' : `Config evaluation process exited with code ${code}`))
    })
  }).catch(error => { throw new ProvisionDiagnostic('provision_config_load_failed', { message: error instanceof Error ? error.message : String(error), secrets }) })
  if (result.kind === 'schema') return result.schema
  if (result.kind === 'invalid-config') throw new ProvisionDiagnostic('provision_invalid_config')
  if (result.kind === 'load-error') throw new ProvisionDiagnostic('provision_config_load_failed', { message: result.message, secrets })
  throw new ProvisionDiagnostic('provision_failed')
}
