import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Private workspace groups are optional in an independent SDK checkout. */
export function sdkWorkspaceDirectories(root: string): string[] {
  return ['packages', 'examples', 'instances', 'apps'].flatMap(group => {
    let entries: string[]
    try { entries = readdirSync(join(root, group)) }
    catch (error) {
      if (group === 'packages' || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      console.log(`SDK workspaces: skipping absent private group ${group}/`)
      return []
    }
    return entries.map(name => join(root, group, name))
  })
}
