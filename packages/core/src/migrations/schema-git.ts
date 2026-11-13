import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import type { MigrationFiles } from './schema-plan'

/** Read-only adapter. Resolve the ref once so all reads use the same tip. */
export function readSchemaBase(root: string, ref: string, lockPath: string, migrationsPath: string): { lock?: string; migrations: MigrationFiles } {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  let tip: string
  try { tip = git('show', '--no-patch', '--format=%H', '--end-of-options', `${ref}^{commit}`).trim() }
  catch { throw new Error(`Unresolvable base ref ${ref}; supply an existing local commit ref (fetch it before planning)`) }
  let top = resolve(root)
  while (!existsSync(resolve(top, '.git'))) {
    if (dirname(top) === top) throw new Error('Schema base requires a Git repository')
    top = dirname(top)
  }
  const path = (file: string) => {
    const name = relative(top, resolve(file)).split(sep).join('/')
    if (name.startsWith('../')) throw new Error(`Schema path outside Git repository: ${file}`)
    return name
  }
  const lockName = path(lockPath), directory = path(migrationsPath)
  const names = execFileSync('git', ['--literal-pathspecs', 'ls-tree', '-r', '-z', '--name-only', tip, '--', lockName, directory], { cwd: top, encoding: 'utf8' }).split('\0').filter(Boolean)
  if (!names.includes(lockName)) {
    let present = false
    try { git('cat-file', '-e', `${tip}:${lockName}`); present = true } catch { /* A lockless base is permitted for --init. */ }
    if (present) throw new Error(`Git listing missed existing lock ${lockName}; refusing incomplete base state`)
  }
  const migrations: Record<string, string> = {}
  for (const name of names) if (name.startsWith(directory + '/') && name.endsWith('.sql')) {
    const file = name.slice(directory.length + 1)
    if (file.includes('/')) throw new Error(`Nested domain migration is unsupported: ${name}`)
    migrations[file] = git('show', `${tip}:${name}`)
  }
  return { lock: names.includes(lockName) ? git('show', `${tip}:${lockName}`) : undefined, migrations }
}
