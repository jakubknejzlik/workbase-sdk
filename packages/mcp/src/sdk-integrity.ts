import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { execute, type CommandOptions } from './sdk-process'

export type SdkVerification = { status: 'pass'; packages: { name: string; archive: string; files: number }[] }

// Hash the raw bytes, including binary assets. execute() decodes stdout as UTF-8.
async function archiveHash(archive: string, file: string, cwd: string, options: CommandOptions) {
  const hash = createHash('sha512')
  const result = await execute(['tar', '-xOf', archive, `package/${file}`], cwd, { ...options, onStdout: chunk => { hash.update(chunk) } })
  if (result.rc !== 0) throw new Error(`Nelze přečíst ${archive}: ${file}: ${result.stderr}`)
  return hash.digest('hex')
}
async function installedHash(path: string, occurrences = 1, signal?: AbortSignal) {
  const hash = createHash('sha512')
  for (let i = 0; i < occurrences; i++) for await (const chunk of createReadStream(path, { signal })) hash.update(chunk)
  return hash.digest('hex')
}
export class SdkIntegrityError extends Error {}
const mismatch = (name: string, file: string, reason: string) => new SdkIntegrityError(`Integrita SDK: ${name}, soubor ${file}: ${reason}.`)
async function installedFiles(root: string, name: string, prefix = ''): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix + entry.name
    if (entry.isDirectory()) files.push(...await installedFiles(root, name, path + '/'))
    else if (entry.isFile()) files.push(path)
    else throw mismatch(name, path, 'očekáván běžný soubor, nikoli odkaz nebo zvláštní soubor')
  }
  return files.sort()
}
export async function verifySdkInstalled(root: string, env = process.env, archiveDirectory = join(root, 'tarballs'), registry = false, options: CommandOptions = {}): Promise<SdkVerification> {
  const commandOptions = { timeoutMs: 30000, ...options, env }
  const archives = new Map<string, string>()
  for (const file of (await readdir(archiveDirectory)).filter(f => f.endsWith('.tgz')).sort()) {
    if (!(await lstat(join(archiveDirectory, file))).isFile()) throw new Error(`Archiv SDK není běžný soubor: ${file}.`)
    const r = await execute(['tar', '-xOf', join(archiveDirectory, file), 'package/package.json'], root, commandOptions)
    if (r.rc !== 0) throw new Error(`Nelze přečíst archiv ${file}: ${r.stderr}`)
    const { name } = JSON.parse(r.stdout)
    if (typeof name !== 'string' || !/^@workbasehq\/[^/]+$/.test(name)) throw new Error(`Neplatný název SDK v archivu ${file}.`)
    if (archives.has(name)) throw new Error(`Duplicitní archiv SDK: ${name}.`)
    archives.set(name, file)
  }
  const scope = join(root, 'node_modules/@workbasehq')
  for (const path of [join(root, 'node_modules'), scope]) if (!(await lstat(path)).isDirectory()) throw new Error(`SDK adresář není samostatný: ${path}.`)
  const installed = (await readdir(scope)).sort()
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const required = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter(n => n.startsWith('@workbasehq/'))
  for (const name of required.sort()) if (!installed.includes(name.slice('@workbasehq/'.length))) throw mismatch(name, 'package.json', 'balíček není nainstalován')
  const packages: SdkVerification['packages'] = []
  for (const entry of installed) {
    const name = `@workbasehq/${entry}`, file = archives.get(name), directory = join(scope, entry)
    if (!file) throw mismatch(name, 'package.json', 'chybí odpovídající archiv')
    if (!(await lstat(directory)).isDirectory()) throw mismatch(name, 'package.json', 'balíček není samostatný adresář')
    const archive = join(archiveDirectory, file)
    const r = await execute(['tar', '-tf', archive], root, commandOptions)
    if (r.rc !== 0) throw new Error(`Nelze vypsat archiv ${file}: ${r.stderr}`)
    const expected = r.stdout.split('\n').filter(p => p && !p.endsWith('/')).map(p => {
      if (!p.startsWith('package/') || p.split('/').some(s => s === '..' || s === '.')) throw new Error(`Neplatná cesta v archivu ${file}: ${p}`)
      return p.slice('package/'.length)
    }).sort()
    if (!registry && new Set(expected).size !== expected.length) throw new Error(`Duplicitní soubory v archivu ${file}.`)
    const actual = await installedFiles(directory, name)
    const expectedSet = new Set(expected), actualSet = new Set(actual)
    for (const path of [...new Set([...expected, ...actual])].sort()) {
      if (!expectedSet.has(path)) throw mismatch(name, path, 'soubor navíc oproti archivu')
      if (!actualSet.has(path)) throw mismatch(name, path, 'chybí soubor z archivu')
      // Bun 1.4.3 preserves package.json byte-for-byte in the real offline
      // fixture and SDK install. No rewritten fields or JSON normalization.
      // npm archives can repeat an aliased binary. tar -xOf concatenates all
      // occurrences: compare against the installed bytes repeated equally.
      // Candidate archives retain their original strict duplicate rejection.
      const occurrences = registry ? expected.filter(file => file === path).length : 1
      if (await archiveHash(archive, path, root, commandOptions) !== await installedHash(join(directory, path), occurrences, options.signal)) throw mismatch(name, path, 'obsah se liší od archivu (SHA-512)')
    }
    packages.push({ name, archive: file, files: expected.length })
  }
  return { status: 'pass', packages }
}
