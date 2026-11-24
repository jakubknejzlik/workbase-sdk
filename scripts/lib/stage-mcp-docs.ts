import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { docNames } from '../../packages/mcp/src/doc-manifest.ts'

/** Release packing uses --ignore-scripts, so stage canonical bytes explicitly. */
export function stageMcpDocs(root: string, destination: string) {
  const docs = join(destination, 'docs')
  rmSync(docs, { recursive: true, force: true })
  mkdirSync(docs, { recursive: true })
  for (const name of docNames) cpSync(join(root, 'docs/sdk', name), join(docs, name))
}
