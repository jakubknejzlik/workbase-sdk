import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { KernelRegistry } from '../kernel/registry'
import { loadConfig } from '../schema/load'
import { generate } from './generate'

/** Instance-root artifact; checking never creates or rewrites files. */
export async function runOpenApiCli(args: readonly string[]): Promise<number> {
  const usage = 'Usage: check:openapi [--config config.ts] [--root .] [--directory .] [--write | --live <origin>]'
  const options = { config: 'config.ts', root: '.', directory: '', write: false, live: '' }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--write') options.write = true
    else if (['--config', '--root', '--directory', '--live'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) options[arg.slice(2) as 'config' | 'root' | 'directory' | 'live'] = args[++i]
    else throw new Error(usage)
  }
  if (options.live && options.write) throw new Error(usage)
  if (options.live) {
    const origin = new URL(options.live)
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error(usage)
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
  let previous: Buffer | undefined
  try { previous = await readFile(target) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (!previous?.equals(Buffer.from(bytes))) {
    console.error(`check:openapi: ${previous === undefined ? 'missing' : 'stale'} openapi.json; run bun run openapi:write`)
    return 1
  }
  if (options.live) {
    try {
      const [spec, build] = await Promise.all(['/openapi.json', '/build.json'].map(path => fetch(new URL(path, options.live), { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000) })))
      if (!spec.ok || !build.ok) throw new Error('metadata unavailable')
      const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
      const served = hash(new Uint8Array(await spec.arrayBuffer()))
      const metadata = await build.json() as { openapi?: unknown }
      if (served !== hash(previous) || served !== metadata.openapi) throw new Error('hash mismatch')
      console.log('check:openapi: live bytes, build.json.openapi and committed file hashes match')
    } catch {
      console.error('check:openapi: live OpenAPI verification failed (served bytes, build.json.openapi and committed file must match)')
      return 1
    }
  }
  console.log('check:openapi: openapi.json matches configuration and registered operations')
  return 0
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await runOpenApiCli(process.argv.slice(2)) }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
