import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export const CONSOLE_SHA_MARKER = 'WORKBASE_BUNDLE_SHA_' + 'X'.repeat(21)
const stamp = /(<meta name="workbase-build-sha" content=")([^"]+)(">)/g

/** Snapshot the complete upload directory, including Vite's copied public assets. */
export async function readConsoleArtifacts(directory: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>()
  async function visit(path: string, prefix: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = prefix + entry.name, file = join(path, entry.name)
      if (entry.isDirectory()) await visit(file, name + '/')
      else if (entry.isFile()) files.set(name, await readFile(file))
      else throw new Error('Console output must contain only files and directories')
    }
  }
  await visit(directory, '')
  return files
}

/** Exclude only self-referential identity/time metadata; preserve all other bytes. */
export function consoleArtifactsSHA(files: Map<string, Buffer>): string {
  const hash = createHash('sha1')
  for (const name of [...files.keys()].filter(name => name !== 'build-meta.json').sort()) {
    const raw = files.get(name)!
    const bytes = name.endsWith('.html')
      ? Buffer.from(raw.toString('latin1').replace(stamp, `$1${CONSOLE_SHA_MARKER}$3`), 'latin1') : raw
    hash.update(JSON.stringify([name, bytes.length]) + '\0').update(bytes)
  }
  return hash.digest('hex')
}

export function consoleHTMLStamps(html: string): string[] {
  return [...html.matchAll(stamp)].map(match => match[2])
}
