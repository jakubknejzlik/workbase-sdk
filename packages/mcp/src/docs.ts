import { URL } from 'node:url'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { docFiles, docNames, type DocName } from './doc-manifest.ts'
import { fail } from './schemas.ts'
import metadata from '../package.json' with { type: 'json' }

export const MAX_DOC_BYTES = 32 * 1024
export class PackagedDocs {
  private realRoot?: Promise<string>
  // Trusted package location, never exposed in tool inputs or outputs.
  constructor(private root = new URL('../', import.meta.url)) {}
  private async components(root: string, name: DocName) {
    const parts = docFiles[name].split('/'), entries = []
    let path = root
    for (const [index, part] of parts.entries()) {
      path = join(path, part)
      const stat = await lstat(path)
      if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
        throw new Error('Packaged document is unavailable')
      }
      entries.push({ path, stat })
    }
    return entries
  }
  async read(name: DocName) {
    // Canonicalize the package boundary once, but check docs/ and every remaining
    // component on each read: resolving docs/ itself would bless a symlink escape.
    const root = await (this.realRoot ??= realpath(this.root))
    const before = await this.components(root, name), document = before[before.length - 1]!
    const file = await open(document.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      const stat = await file.stat(), after = await this.components(root, name)
      // Bind the descriptor to the checked regular file and recheck parent
      // identities after open, so a swapped path cannot supply different bytes.
      if (!stat.isFile() || stat.dev !== document.stat.dev || stat.ino !== document.stat.ino
        || before.some((entry, index) => entry.stat.dev !== after[index]!.stat.dev || entry.stat.ino !== after[index]!.stat.ino)
        || await realpath(document.path) !== document.path) throw new Error('Packaged document is unavailable')
      if (stat.size > MAX_DOC_BYTES) fail('doc_too_large', 'Packaged document exceeds the byte limit', 413)
      // Bound allocation/read even if the packaged file grows after stat.
      const buffer = Buffer.alloc(MAX_DOC_BYTES + 1)
      let length = 0
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null)
        if (!bytesRead) break
        length += bytesRead
      }
      if (length > MAX_DOC_BYTES) fail('doc_too_large', 'Packaged document exceeds the byte limit', 413)
      const bytes = buffer.subarray(0, length), content = bytes.toString('utf8')
      return { ok: true as const, version: metadata.version, name, title: /^#\s+(.+?)\s*$/m.exec(content)?.[1] ?? name,
        sha256: createHash('sha256').update(bytes).digest('hex'), bytes: length, content }
    } finally { await file.close() }
  }
  async list() {
    const docs = await Promise.all(docNames.map(async name => {
      const { name: document, title, sha256, bytes } = await this.read(name)
      return { name: document, title, sha256, bytes }
    }))
    return { ok: true, version: metadata.version, docs }
  }
}
export const packagedDocs = new PackagedDocs()
