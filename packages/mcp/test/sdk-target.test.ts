import { cp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { execute, type CommandOptions } from '../src/sdk-process'
import { captureSdkInputs, runSdkTarget, type TargetOptions } from '../src/sdk-target'
import { digestBytes } from '../src/sdk-upgrade-protocol'
import { RegistryDependencyError, RegistrySdkError } from '../src/sdk-registry'
import { registryFixture } from './fixtures/sdk-registry'

vi.mock('../src/sdk-process', async original => ({ ...await original<typeof import('../src/sdk-process')>(), execute: vi.fn() }))
vi.mock('../src/sdk-upgrade-protocol', async original => ({ ...await original<typeof import('../src/sdk-upgrade-protocol')>(),
  consumerModules: vi.fn(async (root: string) => ({
    packages: ['core', 'plugins', 'mcp'].map(name => ({ name: `@workbasehq/${name}`, version: '0.2.9', directory: join(root, 'node_modules/@workbasehq', name) })),
    resolutions: { tsx: join(root, 'node_modules/tsx/index.js'), wrangler: join(root, 'node_modules/wrangler/bin/wrangler.js') },
  })),
}))
const actual = await vi.importActual<typeof import('../src/sdk-process')>('../src/sdk-process')
const ok = { rc: 0, stdout: '', stderr: '', timedOut: false }
let fixture: Awaited<ReturnType<typeof registryFixture>>, options: TargetOptions, consumer = ''
let install: (cwd: string, options: CommandOptions) => Promise<void>, verifyChild: (cwd: string) => Promise<void>
let preparedChild: (cwd: string) => Promise<void>, commands: string[][]
beforeEach(async () => {
  fixture = await registryFixture()
  await mkdir(join(fixture.root, 'migrations'))
  await writeFile(join(fixture.root, 'config.ts'), 'export default {}\n')
  await writeFile(join(fixture.root, 'migrations/0001_initial.sql'), 'SELECT 1;\n')
  const base = { instanceId: 'fixture', baseRevision: 3, baseFingerprint: 'a'.repeat(64), baseDependencyDigest: 'b'.repeat(64) }
  options = { instanceRoot: fixture.root, checkoutRoot: resolve('.'), targetVersion: fixture.version, base, inputs: await captureSdkInputs(fixture.root), registry: fixture.registry,
    readBase: async () => ({ baseFingerprint: base.baseFingerprint, baseDependencyDigest: base.baseDependencyDigest }) }
  install = async () => {}; verifyChild = async () => {}; preparedChild = async () => {}; commands = []; consumer = ''
  vi.mocked(execute).mockImplementation(async (argv, cwd, commandOptions = {}) => {
    if (argv[0] === 'tar') return actual.execute(argv, cwd, commandOptions)
    consumer = cwd; commands.push(argv)
    if (argv.includes('install')) {
      expect(argv).toContain('--ignore-scripts'); expect(argv).toContain('--no-cache'); expect(argv).toContain('hoisted')
      expect(commandOptions.timeoutMs).toBeLessThanOrEqual(90000)
      expect(commandOptions.maxOutputBytes).toBe(1024 * 1024)
      expect(commandOptions.env).not.toHaveProperty('NODE_OPTIONS')
      expect(commandOptions.env).not.toHaveProperty('WORKBASE_MCP_DEV_MODULE')
      expect(commandOptions.env!.HOME).toBe(join(dirname(cwd), 'home'))
      expect(commandOptions.env!.PATH).not.toContain(resolve('.'))
      await cp(join(fixture.root, 'node_modules'), join(cwd, 'node_modules'), { recursive: true })
      await cp(join(fixture.root, 'bun.lock'), join(cwd, 'bun.lock'))
      await install(cwd, commandOptions)
    } else if (argv.at(-1)?.endsWith('sdk-upgrade-worker.ts')) {
      const request = JSON.parse(await readFile(join(cwd, '.sdk-bridge/request.json'), 'utf8'))
      const marker = { path: 'migrations/0002_sdk_upgrade.sql', sha256: digestBytes('SELECT 2;\n') }
      if (request.action === 'prepare') {
        await writeFile(join(cwd, marker.path), 'SELECT 2;\n')
        await writeFile(join(cwd, '.sdk-bridge/replay.sql'), 'SELECT 1;\nSELECT 2;\n')
        await preparedChild(cwd)
        await writeFile(join(cwd, '.sdk-bridge/result.json'), JSON.stringify({ kind: 'prepared', identity: request.identity, inputHashes: request.inputHashes,
          stage: { marker, replaySha256: digestBytes('SELECT 1;\nSELECT 2;\n') } }))
      } else {
        await verifyChild(cwd)
        await writeFile(join(cwd, '.sdk-bridge/result.json'), JSON.stringify({ ...request, action: undefined, kind: 'verified', coreVersion: fixture.version,
          packages: ['core', 'plugins', 'mcp'].map(name => ({ name: `@workbasehq/${name}`, version: fixture.version, directory: join(cwd, 'node_modules/@workbasehq', name) })),
          resolutions: { tsx: join(cwd, 'node_modules/tsx/index.js'), wrangler: join(cwd, 'node_modules/wrangler/bin/wrangler.js') },
          schema: { status: 'pass', expected: 'c'.repeat(64), applied: 'c'.repeat(64) }, plugins: { expected: 'd'.repeat(64), applied: 'd'.repeat(64) },
          marker: { version: fixture.version, revision: 3 } }))
      }
    }
    return ok
  })
})
afterEach(async () => {
  if (consumer) await expect(readFile(join(consumer, 'package.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  await fixture.close(); vi.clearAllMocks()
})
const run = () => runSdkTarget(options)

const nonRegistrySpecs = [
  'https://example.invalid/private.tgz?token=secret', 'http://example.invalid/package.tgz',
  'git://example.invalid/repo', 'git+https://example.invalid/repo', 'git+ssh://git@example.invalid/repo',
  'git+file:///private/repo', 'github:owner/repo', 'gitlab:owner/repo', 'bitbucket:owner/repo', 'owner/repo',
  'file:../package.tgz', 'link:../package', 'workspace:*', 'npm:other@latest',
  '../package', '/private/package', '~/package', 'package.tgz', 'package.tar.gz',
  'catalog:default', 'portal:../package', 'patch:package@1.0.0', 'custom:package', 'latest',
]
const dependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides', 'resolutions']
const ambiguousRegistrySpecs = [
  // Round-2 probe: four specs in dependencies, overrides and resolutions (12 failures).
  '1.2.3-preview.tgz', '1.2.3+archive.tar.gz', 'v1.2.3-preview.TAR', 'vX',
  'vx', 'vx.x', 'v1', 'v1.2', 'v1.2.3', '^v1.2.3', '>= v1.2.3',
  'v1.2.3 - 2.3.4', '1.2.3 - v2.3.4', '1 || vX',
  '1.2.3+build', '^1.2.3+build', '~1.2.3+build', '>= 1.2.3+build',
  '1.2.3+build - 2.3.4', '1.2.3 - 2.3.4+build', '1 || 2.3.4+build',
  // Bun classifies a bare x/X with a non-dot continuation as a dist-tag.
  'x ', 'X ', 'x\t', 'X\r', 'x\n', 'X\r\n', ' \tX ',
  'x >=1', 'X <2', 'x - 2', 'X - 2', 'x 1.2.3', 'X ~1',
  ...['.tgz', '.tar', '.tar.gz', '.tar.bz2', '.tar.xz', '.tar.zst'].flatMap(extension => [
    `1.2.3-preview${extension.toUpperCase()}`, `^1.2.3-preview${extension}`,
    `>= 1.2.3-preview${extension} <2`, `1.2.3-preview${extension} - 2.0.0`,
    `1.0.0 - 2.0.0-preview${extension}`, `1.2.3-preview${extension} || 2`,
  ]),
  // JS trims these characters; Bun 1.4.3 trims only space, tab, CR and LF
  // before classifying a dependency. These otherwise become dist-tags.
  ...Array.from('\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff', space => `${space}1.2.3`),
]
it.each([...ambiguousRegistrySpecs, ...ambiguousRegistrySpecs.map(spec => `npm:other@${spec}`)])('rejects ambiguous registry requirement %j before invoking Bun', async spec => {
  const originalManifest = options.inputs['package.json'], originalLock = options.inputs['bun.lock']
  for (const location of ['manifest', 'lock', 'workspace', 'metadata']) {
    for (const field of dependencyFields) {
      for (const nested of field === 'overrides' || field === 'resolutions' ? [false, true] : [false]) {
        const manifest = JSON.parse(originalManifest.toString()), lock = JSON.parse(originalLock.toString())
        const requirement = { [field]: nested ? { parent: { unrelated: spec } } : { unrelated: spec } }
        let prefix: string
        if (location === 'manifest') { Object.assign(manifest, requirement); prefix = 'package.json' }
        else if (location === 'lock') { Object.assign(lock, requirement); prefix = 'bun.lock' }
        else if (location === 'workspace') { Object.assign(lock.workspaces[''], requirement); prefix = 'bun.lock.workspaces.' }
        else {
          lock.packages.parent = ['parent@1.2.3', '', requirement, 'sha512-fixture']
          prefix = 'bun.lock.packages.parent.metadata'
        }
        options.inputs['package.json'] = Buffer.from(JSON.stringify(manifest))
        options.inputs['bun.lock'] = Buffer.from(JSON.stringify(lock))
        const error = await run().catch(error => error)
        expect(error).toBeInstanceOf(RegistryDependencyError)
        expect(error).toMatchObject({ code: 'registry_guard', packageName: 'unrelated', field: `${prefix}.${field}.${nested ? 'parent.' : ''}unrelated` })
        expect(error.message).not.toContain(spec)
        expect(commands).toHaveLength(0)
        expect(execute).not.toHaveBeenCalled()
      }
    }
  }
})
it.each(dependencyFields.flatMap(field => nonRegistrySpecs.map(spec => ({ field, spec }))))(
  'rejects non-registry $field source $spec before invoking Bun', async ({ field, spec }) => {
    const manifest = JSON.parse(options.inputs['package.json'].toString())
    manifest[field] = { ...manifest[field], unrelated: spec }
    await writeFile(join(fixture.root, 'package.json'), JSON.stringify(manifest))
    options.inputs = await captureSdkInputs(fixture.root)
    const error = await run().catch(error => error)
    expect(error).toBeInstanceOf(RegistrySdkError)
    expect(error).toMatchObject({ code: 'registry_guard', packageName: 'unrelated', field: `package.json.${field}.unrelated` })
    expect(error.message).toContain('unrelated'); expect(error.message).toContain(field)
    expect(error.message).not.toContain(spec)
    expect(commands).toHaveLength(0)
  },
)
it.each(['overrides', 'resolutions'])('rejects a nested non-registry %s before invoking Bun', async field => {
  const manifest = JSON.parse(options.inputs['package.json'].toString())
  manifest[field] = { parent: { '.': '^1.0.0', unrelated: 'https://example.invalid/private.tgz' } }
  await writeFile(join(fixture.root, 'package.json'), JSON.stringify(manifest))
  options.inputs = await captureSdkInputs(fixture.root)
  await expect(run()).rejects.toMatchObject({ code: 'registry_guard', packageName: 'unrelated', field: `package.json.${field}.parent.unrelated` })
  expect(commands).toHaveLength(0)
})
it.each(nonRegistrySpecs)('rejects captured transitive source %s before invoking Bun', async spec => {
  const lock = JSON.parse(options.inputs['bun.lock'].toString())
  lock.packages['parent/unrelated'] = [`unrelated@${spec}`, '', {}, 'sha512-fixture']
  await writeFile(join(fixture.root, 'bun.lock'), JSON.stringify(lock))
  options.inputs = await captureSdkInputs(fixture.root)
  await expect(run()).rejects.toMatchObject({ code: 'registry_guard', packageName: 'unrelated', field: 'bun.lock.packages.parent/unrelated.resolution' })
  expect(commands).toHaveLength(0)
})
it.each(['captured', 'installed'])('rejects a foreign transitive registry origin in the %s lock', async phase => {
  const lock = JSON.parse(options.inputs['bun.lock'].toString())
  lock.packages.unrelated = ['unrelated@1.2.3', 'https://example.invalid/unrelated/-/unrelated-1.2.3.tgz', {}, 'sha512-fixture']
  if (phase === 'captured') {
    await writeFile(join(fixture.root, 'bun.lock'), JSON.stringify(lock))
    options.inputs = await captureSdkInputs(fixture.root)
  } else install = async cwd => { await writeFile(join(cwd, 'bun.lock'), JSON.stringify(lock)) }
  await expect(run()).rejects.toMatchObject({ code: 'registry_guard', packageName: 'unrelated', field: 'bun.lock.packages.unrelated.registry' })
  expect(commands).toHaveLength(phase === 'captured' ? 0 : 1)
})

it('uses a unique external consumer, preserves unrelated requirements and exact SDK pins, then removes scratch', async () => {
  const manifest = JSON.parse(options.inputs['package.json'].toString())
  manifest.dependencies.unrelated = '^1.2.3'; manifest.devDependencies = { build: '~2.3.4', '@workbasehq/core': '^0.2.8' }
  manifest.scripts = { postinstall: 'touch MUST_NOT_RUN' }
  await writeFile(join(fixture.root, 'package.json'), JSON.stringify(manifest))
  options.inputs = await captureSdkInputs(fixture.root)
  install = async cwd => {
    const staged = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'))
    expect(staged.dependencies.unrelated).toBe('^1.2.3'); expect(staged.devDependencies.build).toBe('~2.3.4')
    expect(staged.devDependencies['@workbasehq/core']).toBe(fixture.version)
    expect(staged.scripts).toEqual(manifest.scripts)
    expect(await realpath(dirname(cwd))).toContain('workbase-sdk-target-')
    expect(cwd).not.toContain(fixture.root); expect(cwd).not.toContain(resolve('.'))
  }
  const proof = await run(), first = consumer
  expect(proof.installed).toHaveLength(3)
  expect(proof.result.marker.revision).toBe(3)
  expect(proof.targetDependencyDigest).not.toBe(options.base.baseDependencyDigest)
  await run(); expect(consumer).not.toBe(first)
})
it.each([false, true])('returns only a request-bound replay diagnostic from a failed bridge (foreign request: %s)', async foreign => {
  const executeMock = vi.mocked(execute).getMockImplementation()!
  vi.mocked(execute).mockImplementation(async (argv, cwd, commandOptions) => {
    if (!argv.at(-1)?.endsWith('sdk-upgrade-worker.ts')) return executeMock(argv, cwd, commandOptions)
    const request = JSON.parse(await readFile(join(cwd, '.sdk-bridge/request.json'), 'utf8'))
    await writeFile(join(cwd, '.sdk-bridge/replay-error.json'), JSON.stringify({
      identity: { ...request.identity, ...(foreign ? { baseFingerprint: '0'.repeat(64) } : {}) }, inputHashes: request.inputHashes,
      diagnostic: { migration: '0001_r1.sql', file: 'migrations/0001_r1.sql', sqlError: 'no such table: missing_source' },
    }))
    return { rc: 1, stdout: 'private output', stderr: 'private output', timedOut: false }
  })
  if (foreign) await expect(run()).rejects.toThrow(/replay error identity/)
  else await expect(run()).rejects.toMatchObject({ code: 'migration_replay_failed',
    message: 'Migration 0001_r1.sql failed in migrations/0001_r1.sql: no such table: missing_source' })
})
it.each(['package.json', 'bun.lock'])('rejects base %s drift during installation and verification', async path => {
  const saved = await readFile(join(fixture.root, path))
  for (const phase of ['install', 'verify']) {
    const drift = async () => { await writeFile(join(fixture.root, path), Buffer.concat([saved, Buffer.from('\n')])) }
    install = phase === 'install' ? drift : async () => {}
    verifyChild = phase === 'verify' ? drift : async () => {}
    await expect(run()).rejects.toThrow(/base input bytes/)
    await writeFile(join(fixture.root, path), saved)
  }
})
it.each(['baseFingerprint', 'baseDependencyDigest'] as const)('checks %s independently without rebasing it to target inputs', async field => {
  const read = options.readBase
  install = async () => { options.readBase = async () => ({ ...await read(), [field]: '0'.repeat(64) }) }
  await expect(run()).rejects.toThrow(/base digests/)
})
it.each(['install', 'verify'])('rejects substituted installed files at %s', async phase => {
  const substitute = async (cwd: string) => { await writeFile(join(cwd, 'node_modules/@workbasehq/core/binary.dat'), 'substitute') }
  if (phase === 'install') install = substitute; else verifyChild = substitute
  await expect(run()).rejects.toThrow(/Integrita SDK|integrit/)
})
it('rebinds archive bytes to registry integrity even if both archive and installed tree are substituted', async () => {
  verifyChild = async cwd => {
    await fixture.substitute()
    await cp(join(fixture.archives, 'core.tgz'), join(dirname(cwd), 'archives/core.tgz'))
    await cp(join(fixture.root, 'node_modules/@workbasehq/core/binary.dat'), join(cwd, 'node_modules/@workbasehq/core/binary.dat'))
  }
  await expect(run()).rejects.toThrow(/dist.integrity/)
})
it.each(['extra', 'nested', 'link'])('rejects %s SDK layout before bridge execution', async kind => {
  install = async cwd => {
    if (kind === 'link') await symlink(fixture.root, join(cwd, 'node_modules/linked'))
    else await mkdir(join(cwd, kind === 'extra' ? 'node_modules/@workbasehq/extra' : 'node_modules/unrelated/dist/node_modules/@workbasehq/core'), { recursive: true })
  }
  await expect(run()).rejects.toThrow()
  expect(commands.some(argv => argv.at(-1)?.endsWith('sdk-upgrade-worker.ts'))).toBe(false)
})
it.each(['workspace:*', 'link:../producer', 'file:../producer.tgz', '../producer', '/tmp/producer'])('rejects local manifest requirement %s before installing', async spec => {
  const manifest = JSON.parse(options.inputs['package.json'].toString())
  manifest.dependencies.unrelated = spec
  options.inputs['package.json'] = Buffer.from(JSON.stringify(manifest))
  await expect(run()).rejects.toMatchObject({ code: 'registry_guard' })
  expect(commands).toHaveLength(0)
})
it.each(['workspace:*', 'link:../producer', 'file:../producer.tgz'])('rejects captured local lock metadata %s', async spec => {
  const lock = JSON.parse(options.inputs['bun.lock'].toString())
  lock.packages.unrelated = [`unrelated@${spec}`, '', {}, 'sha512-fixture']
  options.inputs['bun.lock'] = Buffer.from(JSON.stringify(lock))
  await expect(run()).rejects.toMatchObject({ code: 'registry_guard' })
})
it('rejects a workspace manifest and drift of copied config or staged lock/marker/bridge bytes', async () => {
  for (const path of ['config.ts', 'bun.lock', 'migrations/0002_sdk_upgrade.sql', '.sdk-bridge/sdk-upgrade-worker.ts']) {
    verifyChild = async cwd => { await writeFile(join(cwd, path), (await readFile(join(cwd, path), 'utf8')) + '\n') }
    await expect(run()).rejects.toThrow()
  }
  const manifest = JSON.parse(options.inputs['package.json'].toString()); manifest.workspaces = ['packages/*']
  options.inputs['package.json'] = Buffer.from(JSON.stringify(manifest))
  await expect(run()).rejects.toThrow(/standalone/)
})
it('waits for cancellation of a real child group and removes scratch before returning', async () => {
  const controller = new AbortController(); options.signal = controller.signal
  let pid = 0
  install = async (cwd, commandOptions) => {
    await actual.execute([process.execPath, '-e', "process.on('SIGTERM',()=>{}); const c=require('node:child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});process.stdout.write(String(c.pid));setInterval(()=>{},1000)"], cwd,
      { ...commandOptions, killGraceMs: 50, onStdout: chunk => { pid = Number(chunk.toString()); controller.abort() } })
  }
  await expect(run()).rejects.toThrow()
  expect(pid).toBeGreaterThan(0)
  expect(() => process.kill(pid, 0)).toThrow()
})
