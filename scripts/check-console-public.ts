import { consolePrivateTerms as forbidden } from './lib/public-vocabulary'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
const repo = resolve(import.meta.dirname, '..')
const componentNotice = readFileSync(resolve(repo, 'packages/plugins/console/NOTICE'), 'utf8')
// Only this exact, reviewed legal document may name the component's origin.
// A NOTICE with extra private content still goes through the ordinary scan.
export const consolePublicContent = (path: string, content: string) => path === 'NOTICE' && content === componentNotice ? '' : content
const json = (path: string) => JSON.parse(readFileSync(resolve(repo, path), 'utf8')) as Record<string, unknown>
// Producer-side catalogs are only deny-list inputs; never part of the browser module graph.
const publicKeys = new Set(['en', 'cs'].flatMap(locale => Object.keys(json(`packages/frontend-console/src/locales/${locale}.json`))))
for (const catalog of Object.values(json('packages/core/src/query/enum-labels.json'))) for (const key of Object.keys(catalog as object)) publicKeys.add(key)
export function privateLocaleKeys(root: string, publicKeys: ReadonlySet<string>): Set<string> {
  return new Set(['en', 'cs', 'tiketo-en', 'tiketo-cs'].flatMap(locale => {
    const path = `packages/frontend-console/fixtures/private/locales/${locale}.json`
    let content: string
    try { content = readFileSync(resolve(root, path), 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      console.log(`Public console scan: skipping absent private locale input ${path}`)
      return []
    }
    return Object.keys(JSON.parse(content)).filter(key => !publicKeys.has(key))
  }))
}
const privateKeys = privateLocaleKeys(repo, publicKeys)
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const domainKey = privateKeys.size ? new RegExp(`(?<![\\w])(?:${[...privateKeys].map(escape).join('|')})(?![\\w])`) : null
const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(resolve(directory, entry.name)) : [resolve(directory, entry.name)])
export function checkConsolePublic(directory = resolve(repo, 'packages/frontend-console/dist')) {
  const root = resolve(directory), entries = files(root)
  if (!entries.some(path => path.endsWith('.js'))) throw new Error('Public console scan requires a built JavaScript bundle')
  const failures = entries.flatMap(path => {
    const name = relative(root, path)
    if (lstatSync(path).isSymbolicLink()) return [`${name}: symlink in public assets`]
    if (/\.map$/i.test(name)) return [`${name}: source maps are not public console assets`]
    const content = consolePublicContent(name, readFileSync(path, 'utf8'))
    if (/sourceMappingURL\s*=/.test(content)) return [`${name}: source map reference in public assets`]
    if (forbidden.test(name)) return [`${name}: forbidden public asset path`]
    let match = forbidden.exec(content) ?? domainKey?.exec(content)
    // Vite can hide entire private files inside base64 or percent-encoded data URIs.
    if (!match) for (const [, metadata, payload] of content.matchAll(/data:([^,\s"'`<>]*),([^\s"'`<>\\)]+)/g)) {
      let decoded: string
      try { decoded = /;base64$/i.test(metadata) ? Buffer.from(payload, 'base64').toString('utf8') : decodeURIComponent(payload) }
      catch { continue }
      match = forbidden.exec(decoded) ?? domainKey?.exec(decoded)
      if (match) break
    }
    return match ? [`${relative(root, path)}: forbidden public content ${match[0]}`] : []
  })
  if (failures.length) throw new Error(failures.join('\n'))
  return `Public console scan passed: ${entries.length} assets; 0 private model IDs, ${privateKeys.size} private locale keys excluded, 0 customer names`
}
if (import.meta.main) console.log(checkConsolePublic(process.argv[2]))
