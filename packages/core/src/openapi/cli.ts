import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { KernelRegistry } from '../kernel/registry'
import { loadConfig } from '../schema/load'
import { generate } from './generate'

/** Instance-root artifact; checking never creates or rewrites files. */
export async function runOpenApiCli(args: readonly string[]): Promise<number> {
  const options = { config: 'config.ts', root: '.', directory: '', write: false }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--write') options.write = true
    else if (['--config', '--root', '--directory'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) options[arg.slice(2) as 'config' | 'root' | 'directory'] = args[++i]
    else throw new Error('Usage: check:openapi [--config config.ts] [--root .] [--directory .] [--write]')
  }
  const file = resolve(options.root, options.config)
  const { config, configHash } = await loadConfig(file)
  // Compose the loaded schema, including SDK-registered account commands.
  const kernel = new KernelRegistry(config)
  const bytes = generate(kernel.config, kernel, configHash)
  const target = options.directory ? resolve(options.root, options.directory, 'openapi.json') : resolve(dirname(file), 'openapi.json')
  if (options.write) {
    await writeFile(target, bytes)
    console.log('openapi:write: regenerated openapi.json')
    return 0
  }
  let previous: string | undefined
  try { previous = await readFile(target, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (previous !== bytes) {
    console.error(`check:openapi: ${previous === undefined ? 'missing' : 'stale'} openapi.json; run bun run openapi:write`)
    return 1
  }
  console.log('check:openapi: openapi.json matches configuration and registered operations')
  return 0
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await runOpenApiCli(process.argv.slice(2)) }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
