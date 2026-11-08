import { lstat } from 'node:fs/promises'
import { fail } from './schemas.ts'

export async function noLink(path: string, missing = false) {
  try { if ((await lstat(path)).isSymbolicLink()) fail('unsafe_path', 'Symlinks are forbidden', 403) }
  catch (e) { if (!missing || (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
}
