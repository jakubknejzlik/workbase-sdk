import { createHash } from 'node:crypto'

/** Same exact-byte convention as dependency guards; never decode before hashing. */
export const byteHash = (bytes: Uint8Array) => createHash('sha256').update(Buffer.from(bytes).toString('base64')).digest('hex')
export const byteManifest = (sources: Record<string, Uint8Array>) => Object.fromEntries(Object.entries(sources)
  .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, bytes]) => [path, byteHash(bytes)]))
