import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig } from '../schema/load'
import { checkSchema, parseLock } from './schema-lock'
import { checkBundle, parseBundle } from './schema-bundle'
import { assertBaseFiles, bundleFilename, checkLinkage, plan, type ExistingBundle } from './schema-plan'
import { readSchemaBase } from './schema-git'

export async function runSchemaCli(command: 'plan' | 'check', args: readonly string[]): Promise<number> {
  const options = { root: '.', config: 'config.ts', directory: '', migrations: 'migrations', init: false, base: '', confirmManual: false }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--init' && command === 'plan') options.init = true
    else if (arg === '--confirm-manual' && command === 'plan') options.confirmManual = true
    else if (['--root', '--config', '--directory', '--migrations', '--base'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) {
      options[arg.slice(2) as 'root' | 'config' | 'directory' | 'migrations' | 'base'] = args[++i]
    } else throw new Error('Usage: migrate:plan --base <ref> [--init] [--confirm-manual] | check:schema [--base <ref>]; paths: --root --config --directory --migrations')
  }
  const file = resolve(options.root, options.config)
  const directory = options.directory ? resolve(options.root, options.directory) : dirname(file)
  const lockPath = resolve(directory, 'schema.lock.json'), migrationsPath = resolve(directory, options.migrations)
  const currentLock = existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : undefined
  if (options.init && currentLock) throw new Error('schema.lock.json already exists; --init requires no lock and no domain migrations')
  if (command === 'plan' && !options.init && !options.base) throw new Error('migrate:plan requires --base <ref>; use --init only for a fresh domain')
  const base = options.base ? readSchemaBase(resolve(options.root), options.base, lockPath, migrationsPath) : { lock: undefined, migrations: {} }
  const migrations: Record<string, string> = {}
  if (existsSync(migrationsPath)) for (const name of readdirSync(migrationsPath).filter(name => name.endsWith('.sql'))) migrations[name] = readFileSync(resolve(migrationsPath, name), 'utf8')
  if (options.init && base.lock) throw new Error('--init requires no lock in base; base already has schema.lock.json')
  if (options.init && (Object.keys(migrations).length || Object.keys(base.migrations).length)) throw new Error('--init requires no domain migrations locally or in base')
  if (command === 'plan' && options.base && !base.lock && !options.init) throw new Error('Missing schema.lock.json in base; use migrate:plan --base <ref> --init for a fresh domain')
  const { config, sources } = await loadConfig(file)
  if (command === 'check') {
    try {
      if (!currentLock) throw new Error('Missing schema.lock.json; use migrate:plan --init')
      checkSchema(config, parseLock(currentLock), sources)
      for (const [name, sql] of Object.entries(migrations)) await checkBundle(name, sql)
      if (options.base) await checkLinkage(base.lock, base.migrations, currentLock, migrations)
    } catch (error) { console.error(`check:schema: ${error instanceof Error ? error.message : error}`); return 1 }
    console.log('check:schema: schema, bundles and supplied base linkage match')
    return 0
  }
  let existingBundle: ExistingBundle | undefined
  const added = Object.keys(migrations).filter(name => !(name in base.migrations))
  // A newly merged revision may occupy our pending bundle's filename. Only that
  // pending bundle may be replaced with the new base bytes during renumbering.
  if (currentLock && currentLock !== base.lock) {
    const lock = parseLock(currentLock), filename = bundleFilename(lock.revision)
    if (migrations[filename]) {
      const bundle = parseBundle(filename, migrations[filename])
      if (bundle.revision === lock.revision && bundle.parent === lock.parent && migrations[filename] !== base.migrations[filename]) existingBundle = { filename, sql: migrations[filename] }
    }
  }
  if (added.length > 1 || added.some(name => name !== existingBundle?.filename)) throw new Error(`Expected exactly one pending migration matching the lock; found ${added.length} new files`)
  assertBaseFiles(base.migrations, migrations, existingBundle?.filename)
  const result = await plan({ baseLock: base.lock, baseMigrations: base.migrations, config, existingBundle, confirmManual: options.confirmManual, sources })
  mkdirSync(migrationsPath, { recursive: true })
  if (existingBundle && existingBundle.filename !== result.bundle?.filename) {
    const restored = base.migrations[existingBundle.filename]
    if (restored !== undefined) writeFileSync(resolve(migrationsPath, existingBundle.filename), restored)
    else unlinkSync(resolve(migrationsPath, existingBundle.filename))
  }
  if (result.bundle) writeFileSync(resolve(migrationsPath, result.bundle.filename), result.bundle.sql)
  writeFileSync(lockPath, result.lock)
  console.log(`migrate:plan: r${parseLock(result.lock).revision}; ${result.bundle?.filename ?? 'no pending schema diff'}`)
  return 0
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, ...args] = process.argv.slice(2)
    if (command !== 'plan' && command !== 'check') throw new Error('Expected plan or check')
    process.exitCode = await runSchemaCli(command, args)
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 }
}
