import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig } from '../schema/load'
import { checkSchema, diffSpecs, lockBytes, parseLock, schemaLock } from './schema-lock'

export async function runSchemaCli(command: 'plan' | 'check', args: readonly string[]): Promise<number> {
  const options = { root: '.', config: 'config.ts', directory: '', migrations: 'migrations', init: false }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--init' && command === 'plan') options.init = true
    else if (['--root', '--config', '--directory', '--migrations'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) {
      options[arg.slice(2) as 'root' | 'config' | 'directory' | 'migrations'] = args[++i]
    } else throw new Error(`Usage: ${command === 'plan' ? 'migrate:plan [--init]' : 'check:schema'} [--root .] [--config config.ts] [--directory .] [--migrations migrations]; --base arrives in slice 4b`)
  }
  const file = resolve(options.root, options.config)
  const directory = options.directory ? resolve(options.root, options.directory) : dirname(file)
  const lockPath = resolve(directory, 'schema.lock.json')
  const migrations = resolve(directory, options.migrations)
  const hasLock = existsSync(lockPath)
  if (options.init && hasLock) throw new Error('schema.lock.json already exists; --init requires no lock and no domain migrations')
  if (options.init && existsSync(migrations) && readdirSync(migrations).some(name => name.endsWith('.sql'))) throw new Error('--init requires no domain migrations')
  if (!hasLock && !options.init) throw new Error('Missing schema.lock.json; use migrate:plan --init for a fresh domain. Existing histories require --base (slice 4b).')
  const { config, sources } = await loadConfig(file)
  const base = hasLock ? parseLock(readFileSync(lockPath, 'utf8')) : undefined
  if (command === 'check' || base) {
    try { checkSchema(config, base!, sources) }
    catch (error) {
      if (command === 'plan') throw new Error(`${error instanceof Error ? error.message : error}; planning changes requires --base (slice 4b)`)
      console.error(`check:schema: ${error instanceof Error ? error.message : error}`)
      return 1
    }
    console.log(`${command === 'check' ? 'check:schema' : 'migrate:plan'}: schema matches schema.lock.json`)
    return 0
  }
  const lock = schemaLock(config, undefined, sources)
  const generated = diffSpecs([], lock.tables)
  const sql = `-- workbase:migration r1 parent=none manual=none\n-- workbase:begin pre-data\n-- workbase:end pre-data\n-- workbase:begin generated\n${generated}-- workbase:end generated\n-- workbase:begin post-data\n-- workbase:end post-data\n`
  mkdirSync(migrations, { recursive: true })
  writeFileSync(resolve(migrations, '0001_r1.sql'), sql)
  writeFileSync(lockPath, lockBytes(lock))
  console.log('migrate:plan: wrote schema.lock.json r1 and 0001_r1.sql')
  return 0
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, ...args] = process.argv.slice(2)
    if (command !== 'plan' && command !== 'check') throw new Error('Expected plan or check')
    process.exitCode = await runSchemaCli(command, args)
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 }
}
