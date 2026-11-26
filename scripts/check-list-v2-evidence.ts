import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

/** Validate the collected tree, using portable paths rather than the producer's absolute paths. */
export function checkListV2Evidence(directory: string) {
  const root = realpathSync(directory)
  const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'))
  const captures: { key: string; relativePath: string; sha256: string }[] = []
  const failures: string[] = []
  function visit(value: unknown, key = 'manifest') {
    if (!value || typeof value !== 'object') return
    const entry = value as Record<string, unknown>
    if ('sha256' in entry) {
      if (typeof entry.relativePath !== 'string' || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) failures.push(`${key}: invalid capture path/hash`)
      else captures.push({ key, relativePath: entry.relativePath, sha256: entry.sha256 })
    }
    for (const [name, child] of Object.entries(entry)) visit(child, `${key}.${name}`)
  }
  visit(manifest)
  let matched = 0
  for (const capture of captures) {
    try {
      const path = capture.relativePath
      if (isAbsolute(path) || path.split(/[\\/]/).some(part => part === '..' || part === '.')) throw new Error('capture path must stay inside evidence tree')
      const actual = realpathSync(resolve(root, path))
      const inside = relative(root, actual)
      if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('capture resolves outside evidence tree')
      if (createHash('sha256').update(readFileSync(actual)).digest('hex') !== capture.sha256) throw new Error('SHA-256 mismatch')
      matched++
    } catch (error) { failures.push(`${capture.key}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  if (!captures.length) failures.push('manifest has no hashed captures')
  if (failures.length) throw new Error(`List v2 evidence incomplete: ${matched}/${captures.length} captures matched\n${failures.join('\n')}`)
  return { captures: captures.length, matched }
}
if (import.meta.main) {
  if (process.argv.length !== 3) throw new Error('Usage: bun scripts/check-list-v2-evidence.ts <collected-evidence-directory>')
  console.log(JSON.stringify(checkListV2Evidence(process.argv[2])))
}
