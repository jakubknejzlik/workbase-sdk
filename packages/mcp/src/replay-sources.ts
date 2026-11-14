import { constants } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { noLink } from './paths.ts'

/** Authored V3 inputs needed to load the template's deploy-time composition. */
export async function replaySources(root: string): Promise<Record<string, Buffer>> {
  const sources: Record<string, Buffer> = {}
  const read = async (path: string) => {
    await noLink(join(root, path), true)
    try { sources[path] = await readFile(join(root, path), { flag: constants.O_RDONLY | constants.O_NOFOLLOW }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  for (const path of ['runtime.ts', 'access.ts', 'schema.lock.json']) await read(path)
  const schema = async (directory: string): Promise<void> => {
    await noLink(join(root, directory), true)
    let entries
    try { entries = await readdir(join(root, directory), { withFileTypes: true }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`
      await noLink(join(root, path))
      if (entry.isDirectory()) await schema(path)
      else if (entry.name.endsWith('.ts')) await read(path)
    }
  }
  await schema('schema')
  return sources
}
