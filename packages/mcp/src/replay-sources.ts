import { constants } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { noLink } from './paths.ts'

/** Authored V3 inputs; composition guards may also capture both audit artifacts.
 * SDK upgrade capture retains its existing source-only protocol. */
export async function replaySources(root: string, options: { accessLock?: boolean; presentation?: boolean } = {}): Promise<Record<string, Buffer>> {
  const sources: Record<string, Buffer> = {}
  const read = async (path: string) => {
    await noLink(join(root, path), true)
    try { sources[path] = await readFile(join(root, path), { flag: constants.O_RDONLY | constants.O_NOFOLLOW }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  for (const path of ['runtime.ts', 'access.ts', 'schema.lock.json', ...(options.accessLock ? ['access.lock.json', 'access.lock.md', 'openapi.json'] : [])]) await read(path)
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
  if (options.presentation) {
    const tree = async (directory: string): Promise<void> => {
      await noLink(join(root, directory), true)
      let entries
      try { entries = await readdir(join(root, directory), { withFileTypes: true }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        const path = `${directory}/${entry.name}`
        await noLink(join(root, path))
        if (entry.isDirectory()) await tree(path)
        // Retained transaction files are private recovery inputs, not catalogs.
        else if (directory.startsWith('ui') || entry.name.endsWith('.json')) await read(path)
      }
    }
    await tree('ui'); await tree('locales')
    // Domain revision does not change for presentation publication. Receipts
    // serialize even competing proposals whose resulting catalog bytes agree.
    await noLink(join(root, 'proposals'), true)
    const proposals = await readdir(join(root, 'proposals')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    for (const name of proposals.filter(name => /^[a-f0-9-]+\.json$/.test(name)).sort()) {
      await noLink(join(root, 'proposals', name))
      const bytes = await readFile(join(root, 'proposals', name))
      let proposal
      try { proposal = JSON.parse(bytes.toString('utf8')) }
      catch { continue } // Unpromoted transaction metadata need not be a receipt.
      if (proposal?.kind === 'composition_change' && proposal.status === 'promoted'
        && Array.isArray(proposal.changes) && proposal.changes.some((change: { kind?: string } | null) => change && ['set_locale', 'set_catalog_entries'].includes(change.kind ?? ''))) sources[`proposals/${name}`] = bytes
    }
  }
  return sources
}
