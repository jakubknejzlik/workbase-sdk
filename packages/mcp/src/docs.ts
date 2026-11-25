import { URL } from 'node:url'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { docFiles, docNames, type DocName } from './doc-manifest.ts'
import { fail } from './schemas.ts'
import metadata from '../package.json' with { type: 'json' }

export const MAX_DOC_BYTES = 32 * 1024
type DocumentSnapshot = { raw: Buffer; title: string; sha256: string }
export class PackagedDocs {
  private snapshot?: Promise<Map<DocName, DocumentSnapshot>>
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
  private async loadDocument(root: string, name: DocName): Promise<DocumentSnapshot> {
    // Resolving docs/ itself would bless a symlink escape. Keep the containment
    // checks when loading each allowlisted document into the private snapshot.
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
      const raw = buffer.subarray(0, length)
      return { raw, title: /^#\s+(.+?)\s*$/m.exec(raw.toString('utf8'))?.[1] ?? name,
        sha256: createHash('sha256').update(raw).digest('hex') }
    } finally { await file.close() }
  }
  private documents() {
    // Share one atomic load across readers. Never publish a partial snapshot;
    // discard failures so a later call can retry after the package is repaired.
    return this.snapshot ??= (async () => {
      const root = await realpath(this.root)
      const docs = new Map<DocName, DocumentSnapshot>()
      for (const name of docNames) docs.set(name, await this.loadDocument(root, name))
      return docs
    })().catch(error => { this.snapshot = undefined; throw error })
  }
  async read(name: DocName) {
    const { raw, title, sha256 } = (await this.documents()).get(name)!
    // The raw buffer stays private: callers receive detached response objects.
    return { ok: true as const, version: metadata.version, name, title, sha256,
      bytes: raw.length, content: raw.toString('utf8') }
  }
  async list() {
    const snapshot = await this.documents()
    const docs = docNames.map(name => {
      const { raw, title, sha256 } = snapshot.get(name)!
      return { name, title, sha256, bytes: raw.length }
    })
    return { ok: true, version: metadata.version, docs }
  }
}
export const packagedDocs = new PackagedDocs()
