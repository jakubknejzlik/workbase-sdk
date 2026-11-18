import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { createProvisionPlan, type ProvisionOptions } from '../../packages/core/src/infra/provision'
import { consoleArtifactsSHA, readConsoleArtifacts } from '../../packages/core/src/console-build'
import { stageConsolePackage } from '../lib/stage-console-package'
import { stageConsoleAssets } from '../stage-console-assets'

const root = resolve(import.meta.dirname, '../..')
let scratch: string, assets: string, options: ProvisionOptions
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'workbase-packaged-provision-'))
  vi.stubEnv('NODE_ENV', 'production')
  try { stageConsoleAssets(root) } finally { vi.unstubAllEnvs() }
  const staged = join(scratch, 'plugins')
  stageConsolePackage(root, 'plugins', staged)
  assets = join(staged, 'console/assets')
  mkdirSync(join(scratch, 'migrations'))
  writeFileSync(join(scratch, 'package.json'), '{"type":"module"}\n')
  writeFileSync(join(scratch, 'config.ts'), "export default { id: 'packaged', revision: 1, roles: ['owner'], entities: {}, plugins: [] }\n")
  writeFileSync(join(scratch, 'worker.ts'), 'export default { fetch() { return new Response("ok") } }\n')
  writeFileSync(join(scratch, 'migrations/0001_initial.sql'), 'CREATE TABLE records (id TEXT PRIMARY KEY);\n')
  options = { projectRoot: scratch, configPath: 'config.ts', handler: 'worker.ts', migrationsDir: 'migrations',
    resourcePrefix: 'packaged-console', stage: 'test', authSecret: 'synthetic-plan-only-secret-00000000',
    authBaseUrl: 'https://example.invalid', assetsDir: assets }
}, 180000)
afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }) })

test('staged packaged console passes plan-only provisioning with artifact identity and separate source provenance', async () => {
  await expect(createProvisionPlan(options)).resolves.toMatchObject({ assetsDir: assets })
  const metadata = JSON.parse(readFileSync(join(assets, 'build-meta.json'), 'utf8'))
  expect(metadata.sha).toBe(consoleArtifactsSHA(await readConsoleArtifacts(assets)))
  expect(metadata.sourceCommit).toBe(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim())
  expect(metadata.version).toBe(JSON.parse(readFileSync(join(root, 'packages/plugins/package.json'), 'utf8')).version)
  // Staging must preserve the final emitted directory, including hashed JS/CSS/locales.
  expect(await readConsoleArtifacts(assets)).toEqual(await readConsoleArtifacts(join(root, 'packages/frontend-console/dist')))
}, 30000)

test('a one-byte JS change in staged packaged assets fails provision verification', async () => {
  const tampered = join(scratch, 'tampered')
  cpSync(assets, tampered, { recursive: true })
  const file = readdirSync(join(tampered, 'assets')).find(name => name.endsWith('.js'))!
  const path = join(tampered, 'assets', file), bytes = readFileSync(path)
  bytes[0] ^= 1
  writeFileSync(path, bytes)
  await expect(createProvisionPlan({ ...options, assetsDir: tampered })).rejects.toMatchObject({ code: 'provision_console_sha_mismatch' })
})
