import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkConsolePublic } from '../check-console-public'

/** Registry-safe core/plugins payloads shared by release packing and consumer smoke. */
export function stageConsolePackage(root: string, name: 'core' | 'plugins', destination: string) {
  const source = join(root, 'packages', name)
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  delete manifest.devDependencies
  delete manifest.scripts // Producer prepack paths must never run outside the checkout.
  for (const kind of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [dependency, spec] of Object.entries(manifest[kind] ?? {})) {
      if (/^(?:workspace:|file:|link:)/.test(String(spec))) throw new Error(`Non-registry dependency: ${dependency}`)
    }
  }
  mkdirSync(destination, { recursive: true })
  if (name === 'core') cpSync(join(source, 'src'), join(destination, 'src'), { recursive: true })
  else {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue
      // Plugin source directories, without test/producer workspaces.
      const src = join(source, entry.name, 'src')
      if (readdirSync(join(source, entry.name)).includes('src')) cpSync(src, join(destination, entry.name, 'src'), { recursive: true })
    }
    const assets = join(source, 'console/assets')
    const metadata = JSON.parse(readFileSync(join(assets, 'build-meta.json'), 'utf8'))
    if (metadata.version !== manifest.version || metadata.primitivesProof) throw new Error('Rebuild console assets for the plugins version before packing')
    console.log(checkConsolePublic(assets))
    cpSync(assets, join(destination, 'console/assets'), { recursive: true })
  }
  cpSync(join(root, 'LICENSE'), join(destination, 'LICENSE'))
  cpSync(join(source, 'NOTICE'), join(destination, 'NOTICE'))
  writeFileSync(join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
}
