import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { KernelRegistry } from '../kernel/registry'
import { isSchemaConfig } from '../schema'
import { configSources } from '../schema/load'
import { syncAccessLock } from '../access-lock'

/** Trusted config modules may register plugins and commands; compose before auditing. */
export async function runAccessCli(args: readonly string[]): Promise<number> {
  const options = { config: 'config.ts', root: '.', directory: '.', write: false }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--write') options.write = true
    else if (['--config', '--root', '--directory'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) {
      options[arg.slice(2) as 'config' | 'root' | 'directory'] = args[++i]
    } else throw new Error('Usage: check:access [--config config.ts] [--root .] [--directory .] [--write]')
  }
  const root = resolve(options.root)
  const file = resolve(root, options.config)
  const config = (await import(pathToFileURL(file).href)).default
  if (!config || typeof config !== 'object') throw new Error('Config must default-export an instance configuration')
  // Skip before composing legacy modules: their old runtime behavior stays untouched.
  if (!isSchemaConfig(config)) {
    console.log('check:access: skip legacy defineInstance config (no access lock)')
    return 0
  }
  const result = await syncAccessLock({ ...options, root, kernel: new KernelRegistry(config), sources: configSources(file) })
  console.log(result.message)
  return result.ok ? 0 : 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await runAccessCli(process.argv.slice(2)) }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
