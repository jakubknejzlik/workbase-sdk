import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { checkTerminology } from './check-terminology'
const run = (args: string[]) => execFileSync('bun', args, { stdio: 'inherit' })
run(['packages/frontend-console/generate-routes.ts'])
run(['run', '--cwd', 'packages/ui', 'build'])
// Explicit local proof build only; ordinary production builds eliminate the harness chunk.
run(['run', '--cwd', 'packages/frontend-console', 'build', ...(process.env.CONSOLE_PRIMITIVES_PROOF === '1' ? ['--mode', 'primitives-proof'] : [])])
const { version } = JSON.parse(readFileSync('packages/plugins/package.json', 'utf8'))
const build = { version, ...(process.env.CONSOLE_PRIMITIVES_PROOF === '1' ? { primitivesProof: true } : {}), sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), builtAt: new Date().toISOString() }
mkdirSync('packages/frontend-console/dist', { recursive: true })
mkdirSync('packages/frontend-console/dist/locales', { recursive: true })
for (const locale of ['en', 'cs']) cpSync(`packages/frontend-console/src/locales/${locale}.json`, `packages/frontend-console/dist/locales/${locale}.json`)
writeFileSync('packages/frontend-console/dist/build-meta.json', JSON.stringify(build) + '\n')
run(['scripts/check-console-public.ts'])
checkTerminology(undefined, { requireBuild: true })
console.log('Console built:', build.sha)
