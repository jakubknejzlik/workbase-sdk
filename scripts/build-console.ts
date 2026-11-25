import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { CONSOLE_SHA_MARKER, consoleArtifactsSHA, readConsoleArtifacts } from '../packages/core/src/console-build'
import { checkTerminology } from './check-terminology'
const run = (args: string[]) => execFileSync('bun', args, { stdio: 'inherit' })
run(['packages/frontend-console/generate-routes.ts'])
run(['run', '--cwd', 'packages/ui', 'build'])
// Explicit local proof build only; ordinary production builds eliminate the harness chunk.
run(['run', '--cwd', 'packages/frontend-console', 'build', ...(process.env.CONSOLE_PRIMITIVES_PROOF === '1' ? ['--mode', 'primitives-proof'] : [])])
const { version } = JSON.parse(readFileSync('packages/plugins/package.json', 'utf8'))
mkdirSync('packages/frontend-console/dist', { recursive: true })
mkdirSync('packages/frontend-console/dist/locales', { recursive: true })
for (const locale of ['en', 'cs']) cpSync(`packages/frontend-console/src/locales/${locale}.json`, `packages/frontend-console/dist/locales/${locale}.json`)
cpSync('LICENSE', 'packages/frontend-console/dist/LICENSE')
cpSync('packages/plugins/console/NOTICE', 'packages/frontend-console/dist/NOTICE')
mkdirSync('packages/frontend-console/dist/licenses/alata', { recursive: true })
cpSync('packages/ui/src/assets/fonts/OFL.txt', 'packages/frontend-console/dist/licenses/alata/OFL.txt')
// Hash the final upload tree, including public assets, locales and legal files.
// Match consoleUI() writeBundle ordering: hash, stamp HTML only, then metadata.
const directory = 'packages/frontend-console/dist'
const files = await readConsoleArtifacts(directory), sha = consoleArtifactsSHA(files)
for (const [name, bytes] of files) {
  if (name.endsWith('.html') && bytes.includes(CONSOLE_SHA_MARKER)) {
    writeFileSync(`${directory}/${name}`, Buffer.from(bytes.toString('latin1').replaceAll(CONSOLE_SHA_MARKER, sha), 'latin1'))
  }
}
const build = { version, ...(process.env.CONSOLE_PRIMITIVES_PROOF === '1' ? { primitivesProof: true } : {}), sha,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), builtAt: new Date().toISOString() }
writeFileSync('packages/frontend-console/dist/build-meta.json', JSON.stringify(build) + '\n')
run(['scripts/check-console-public.ts'])
await checkTerminology(undefined, { requireBuild: true })
console.log('Console built:', build.sha)
