import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { checkConsolePublic } from './check-console-public'

/** Producer-only prepack: consumers install static bytes and never run this script. */
export function stageConsoleAssets(root = resolve(import.meta.dirname, '..')) {
  // Always rebuild: stale dist or a primitives-proof build must never enter npm.
  execFileSync('bun', ['run', 'console:build'], { cwd: root, stdio: 'inherit', env: { ...process.env, CONSOLE_PRIMITIVES_PROOF: '0' } })
  const consoleDirectory = resolve(root, 'packages/plugins/console')
  const target = resolve(consoleDirectory, 'assets'), pending = resolve(consoleDirectory, 'assets.pending')
  rmSync(pending, { recursive: true, force: true })
  try {
    mkdirSync(pending)
    cpSync(resolve(root, 'packages/frontend-console/dist'), pending, { recursive: true })
    cpSync(resolve(root, 'LICENSE'), resolve(pending, 'LICENSE'))
    cpSync(resolve(consoleDirectory, 'NOTICE'), resolve(pending, 'NOTICE'))
    const metadata = JSON.parse(readFileSync(resolve(pending, 'build-meta.json'), 'utf8'))
    const manifest = JSON.parse(readFileSync(resolve(root, 'packages/plugins/package.json'), 'utf8'))
    if (metadata.version !== manifest.version || metadata.primitivesProof) throw new Error('Console build metadata does not match the plugins release')
    console.log(checkConsolePublic(pending))
    rmSync(target, { recursive: true, force: true })
    renameSync(pending, target)
    return target
  } finally { rmSync(pending, { recursive: true, force: true }) }
}

if (import.meta.main) stageConsoleAssets()
