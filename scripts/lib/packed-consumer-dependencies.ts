import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const migration = { tsx: '4.23.15', typescript: '5.7.2', '@types/node': '25.9.9', '@cloudflare/workers-types': '5.20261022.1' }
const deployment = { ...migration, sst: '4.17.1', '@pulumi/command': '1.2.1', '@pulumi/pulumi': '3.215.0', esbuild: '0.21.5' }
export type ConsumerProfile = 'migration' | 'deployment' | 'loader'

/** Registry preparation happens before creating the isolated proof stage. No SDK workspace is installed here. */
export function prepareConsumerDependencies(root: string): string {
  const dependencies = (name: string) => JSON.parse(readFileSync(resolve(root, 'packages', name, 'package.json'), 'utf8')).dependencies
  const core = dependencies('core')
  const profiles = {
    migration: { ...core, ...migration },
    deployment: { ...core, ...deployment },
    loader: { ...core, ...dependencies('plugins'), tsx: '4.23.15', 'ts-node': '10.9.2', typescript: '5.7.2', esbuild: '0.21.5' },
  }
  const key = createHash('sha256').update(JSON.stringify(profiles)).update(process.platform + process.arch).digest('hex')
  const cache = resolve(tmpdir(), 'workbase-proof-consumers', key)
  if (existsSync(resolve(cache, 'ready'))) return realpathSync(cache)
  mkdirSync(dirname(cache), { recursive: true })
  const preparing = mkdtempSync(resolve(dirname(cache), 'preparing-'))
  try {
    for (const [profile, deps] of Object.entries(profiles)) {
      const cwd = resolve(preparing, profile)
      mkdirSync(cwd)
      writeFileSync(resolve(cwd, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: deps }))
      console.log(`Preparing packed-consumer dependencies outside isolation: ${profile}`)
      execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'], { cwd, stdio: 'inherit', timeout: 180000 })
    }
    writeFileSync(resolve(preparing, 'ready'), key)
    renameSync(preparing, cache)
    return realpathSync(cache)
  } finally { rmSync(preparing, { recursive: true, force: true }) }
}

/** Copy registry bytes, then extract the candidate tarballs produced by this test. */
export function usePreparedConsumerDependencies(consumer: string, profile: ConsumerProfile, archives: Record<string, string>): boolean {
  const prepared = process.env.WORKBASE_PREPARED_CONSUMERS
  if (!prepared) return false
  if (!existsSync(resolve(prepared, 'ready'))) throw new Error('Packed consumer dependencies were not prepared')
  const modules = resolve(consumer, 'node_modules')
  rmSync(modules, { recursive: true, force: true })
  cpSync(resolve(prepared, profile, 'node_modules'), modules, { recursive: true, verbatimSymlinks: true })
  for (const [name, archive] of Object.entries(archives)) {
    const destination = resolve(modules, '@workbasehq', name)
    mkdirSync(destination, { recursive: true })
    execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', destination])
  }
  mkdirSync(resolve(modules, '.bin'), { recursive: true })
  symlinkSync('../@workbasehq/core/src/infra/bin.mjs', resolve(modules, '.bin/workbase-migrate'))
  return true
}

/** Fail closed on package-manager installation, even when an offline cache could satisfy it. */
export function noInstallEnvironment(directory: string, env: NodeJS.ProcessEnv, allowBuild = false): NodeJS.ProcessEnv {
  mkdirSync(directory, { recursive: true })
  for (const manager of ['npm', 'bun', 'npx', 'bunx', 'yarn', 'pnpm']) {
    const binary = ['npm', 'bun'].includes(manager) ? execFileSync('/bin/sh', ['-c', `command -v ${manager}`], { env, encoding: 'utf8' }).trim() : '/usr/bin/false'
    const build = allowBuild ? ' || [ "$1" = test ] || [ "$1" = run ] || { [ "$1" = pm ] && [ "$2" = pack ]; } || [ "$1" = - ] || [ -f "$1" ]' : ''
    const allowed = manager === 'npm' ? '[ "$1" = pack ]' : manager === 'bun' ? `([ "$1" = x ] && [ "$2" = --no-install ])${build} || ([ "$1" = --no-install ] && { [ "$2" = --eval ] || [ -f "$2" ]; })` : 'false'
    writeFileSync(resolve(directory, manager), `#!/bin/sh\nif ${allowed}; then exec '${binary}' "$@"; fi\necho 'SDK proof forbids package-manager install: ${manager}' >&2\nexit 97\n`, { mode: 0o755 })
  }
  return { ...env, PATH: `${directory}:${env.PATH}`, npm_config_offline: 'true', npm_config_registry: 'http://127.0.0.1:9/', BUN_CONFIG_REGISTRY: 'http://127.0.0.1:9/', BUN_CONFIG_SKIP_INSTALL_PACKAGES: '1' }
}
