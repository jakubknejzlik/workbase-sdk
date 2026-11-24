import { URL } from 'node:url'
import { open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { docFiles, docNames, type DocName } from './doc-manifest.ts'
import { fail } from './schemas.ts'
import metadata from '../package.json' with { type: 'json' }

export const MAX_DOC_BYTES = 32 * 1024
export class PackagedDocs {
  // Trusted package location, never exposed in tool inputs or outputs.
  constructor(private root = new URL('../', import.meta.url)) {}
  async read(name: DocName) {
    const file = await open(new URL(docFiles[name], this.root), 'r')
    try {
      if ((await file.stat()).size > MAX_DOC_BYTES) fail('doc_too_large', 'Packaged document exceeds the byte limit', 413)
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
