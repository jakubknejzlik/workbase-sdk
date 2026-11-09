import { mkdir, opendir, readFile, readdir, realpath, rename, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { assertRegistryLock, assertRegistryManifest, downloadRegistryArchives, RegistryDependencyError, resolveRegistrySdk, verifyRegistryConsumer } from '../src/sdk-registry'
import { registryFixture } from './fixtures/sdk-registry'

vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, opendir: vi.fn(fs.opendir) }
})

let fixture: Awaited<ReturnType<typeof registryFixture>>
beforeEach(async () => { fixture = await registryFixture() })
afterEach(async () => { await fixture.close() })
const verify = () => verifyRegistryConsumer(fixture.root, { source: 'registry', version: fixture.version, registry: fixture.registry, packages: fixture.packages }, fixture.archives)

const dependencyFields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'overrides', 'resolutions']
const cliuiPackages = {
  '@isaacs/cliui': ['@isaacs/cliui@8.0.2', '', { dependencies: {
    'string-width': '^5.1.2', 'string-width-cjs': 'npm:string-width@^4.2.0',
    'strip-ansi': '^7.0.1', 'strip-ansi-cjs': 'npm:strip-ansi@^6.0.1',
    'wrap-ansi': '^8.1.0', 'wrap-ansi-cjs': 'npm:wrap-ansi@^7.0.0',
  } }, 'sha512-O8jcjabXaleOG9DQ0+ARXWZBTfnP4WNAqzuiJK7ll44AmxGKv/J2M4TPjxjY3znBCfvBXFzucm1twdyFybFqEA=='],
  'string-width-cjs': ['string-width@4.2.3', '', { dependencies: { 'emoji-regex': '^8.0.0', 'is-fullwidth-code-point': '^3.0.0', 'strip-ansi': '^6.0.1' } }, 'sha512-wKyQRQpjJ0sIp62ErSZdGsjMJWsap5oRNihHhu6G7JVO/9jIB6UyevL+tXuOqrng8j/cxKTWyWUwvSTriiZz/g=='],
  'strip-ansi-cjs': ['strip-ansi@6.0.1', '', { dependencies: { 'ansi-regex': '^5.0.1' } }, 'sha512-Y38VPSHcqkFrCpFnQ9vuSXmquuv5oXOKpGeT6aGrr3o3Gc9AlVa6JBfUSOCnbxGGZF+/0ooI7KrPuUSztUdU5A=='],
  'wrap-ansi-cjs': ['wrap-ansi@7.0.0', '', { dependencies: { 'ansi-styles': '^4.0.0', 'string-width': '^4.1.0', 'strip-ansi': '^6.0.0' } }, 'sha512-YVGIj2kamLSTxw6NsZjoBxfSwsn0ycdesmc4p+Q21c5zPuZ1pl+NfxVdxPtdHvmNVOQ6XSYG4AUtyt/Fi7D16Q=='],
}
it('accepts the real @isaacs/cliui lock shape with three npm aliases', async () => {
  const path = join(fixture.root, 'bun.lock'), lock = JSON.parse(await readFile(path, 'utf8'))
  Object.assign(lock.packages, cliuiPackages)
  await writeFile(path, JSON.stringify(lock))
  expect((await verify()).status).toBe('pass')
})
it.each(['npm:other@^1.2.3', 'npm:@scope/pkg@~2.3', 'npm:a-b.c_d~e@>= 1 <2', 'npm:other@*', 'npm:other@1 || 2'])(
  'accepts registry alias %s in every dependency location', async spec => {
    for (const field of dependencyFields) {
      for (const nested of field === 'overrides' || field === 'resolutions' ? [false, true] : [false]) {
        const metadata = { [field]: nested ? { parent: { '.': spec, alias: spec } } : { alias: spec } }
        expect(() => assertRegistryManifest(metadata)).not.toThrow()
        const lock = { ...metadata, workspaces: { '': metadata }, packages: {
          alias: [spec.slice(4, spec.lastIndexOf('@')) + '@1.2.3', '', {}, 'sha512-fixture'],
          parent: ['parent@1.0.0', '', metadata, 'sha512-fixture'],
        } }
        expect(() => assertRegistryLock(JSON.stringify(lock), fixture.registry)).not.toThrow()
      }
    }
  },
)
it.each([
  'npm:other', 'npm:@scope/pkg', 'npm:other@', 'npm:other@latest', 'npm:@scope/pkg@next',
  'npm:npm:other@1.2.3', 'npm:other@npm:target@1.2.3',
  ...['../other', 'a..b', 'other/path', '/other', '@scope/../other', '@scope/other/path',
    'Other', '@Scope/pkg', '@scope/Pkg', 'other name', ' other', 'other\t', 'other\n', 'other\r', '.other', '_other',
    '', '@scope', '@scope/', '@/pkg', 'https://example.invalid/pkg', 'other%2fpath', 'other\\path',
    'node_modules', 'favicon.ico', 'a'.repeat(215)].map(name => `npm:${name}@1.2.3`),
  ...['file:../other', 'link:../other', 'workspace:*', '../other', '/tmp/other', 'other.tgz',
    'https://user:secret@example.invalid/other.tgz', 'git+https://example.invalid/repo', 'github:owner/repo',
    '1.2.3-preview.tgz', '1.2.3+build', 'v1.2.3', 'x ', '\u00a01.2.3'].map(range => `npm:other@${range}`),
])('rejects hostile npm alias %j in every dependency location', spec => {
  for (const field of dependencyFields) {
    for (const nested of field === 'overrides' || field === 'resolutions' ? [false, true] : [false]) {
      const metadata = { [field]: nested ? { parent: { alias: spec } } : { alias: spec } }
      for (const check of [
        () => assertRegistryManifest(metadata),
        () => assertRegistryLock(JSON.stringify({ ...metadata, workspaces: {}, packages: {} })),
        () => assertRegistryLock(JSON.stringify({ workspaces: { '': metadata }, packages: {} })),
        () => assertRegistryLock(JSON.stringify({ workspaces: {}, packages: { parent: ['parent@1.0.0', '', metadata, 'sha512-fixture'] } })),
      ]) {
        expect(check).toThrow(RegistryDependencyError)
        expect(check).toThrow(expect.objectContaining({ code: 'registry_guard', packageName: 'alias' }))
      }
    }
  }
})
it.each(['alias', 'parent/alias', '@scope/alias', 'parent/@scope/alias'])(
  'checks configured origin for aliased lock entry %s', async key => {
    const lock = JSON.parse(await readFile(join(fixture.root, 'bun.lock'), 'utf8'))
    const alias = key.includes('@scope/') ? '@scope/alias' : 'alias'
    lock.workspaces[''].dependencies[alias] = 'npm:@target/pkg@^1'
    lock.packages[key] = ['@target/pkg@1.2.3', `${fixture.registry}/@target/pkg/-/pkg-1.2.3.tgz`, {}, 'sha512-fixture']
    expect(() => assertRegistryLock(JSON.stringify(lock), fixture.registry)).not.toThrow()
    lock.packages[key][1] = 'https://example.invalid/pkg.tgz'
    expect(() => assertRegistryLock(JSON.stringify(lock), fixture.registry)).toThrow(expect.objectContaining({
      code: 'registry_guard', packageName: '@target/pkg', field: `bun.lock.packages.${key}.registry`,
    }))
    lock.packages[key][1] = ''
    lock.packages[key][0] = '@wrong/pkg@1.2.3'
    expect(() => assertRegistryLock(JSON.stringify(lock), fixture.registry)).toThrow(expect.objectContaining({ field: `bun.lock.packages.${key}.resolution` }))
    delete lock.workspaces[''].dependencies[alias]
    lock.packages[key][0] = '@target/pkg@1.2.3'
    expect(() => assertRegistryLock(JSON.stringify(lock), fixture.registry)).toThrow(expect.objectContaining({ field: `bun.lock.packages.${key}.resolution` }))
  },
)

it.each(['0.2.10', '1.2.3', '1.2.3-beta.1', '^1.2.3', '~1.2', '>= 1.0.0 <2', '1.2.3 - 2.3.4', '^1 || ~2.3', '*', '1.x', 'X.x', 'x', 'X', ' \tx', 'x || 1', 'X || 2', ' \t\r\n^1.2.3 '])(
  'preserves registry semver requirement %s', spec => {
    const manifest = { dependencies: { unrelated: spec }, overrides: { parent: { '.': spec, unrelated: spec } } }
    assertRegistryManifest(manifest)
    expect(manifest.dependencies.unrelated).toBe(spec)
  },
)
it.each(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides', 'resolutions'])(
  'rejects transitive %s source metadata', async field => {
    const lock = JSON.parse(await readFile(join(fixture.root, 'bun.lock'), 'utf8'))
    lock.packages.parent = ['parent@1.2.3', '', { [field]: { unrelated: 'git+file:///private/repo' } }, 'sha512-fixture']
    expect(() => assertRegistryLock(JSON.stringify(lock), fixture.registry)).toThrow(expect.objectContaining({
      code: 'registry_guard', packageName: 'unrelated', field: `bun.lock.packages.parent.metadata.${field}.unrelated`,
    }))
  },
)
it.each(['https://example.invalid/package.tgz', 'git+file:///private/repo', 'file:../package', '//registry.npmjs.org/package.tgz', 'https://user:secret@registry.example.invalid/package.tgz'])(
  'rejects a non-registry lock origin %s', async origin => {
    const lock = JSON.parse(await readFile(join(fixture.root, 'bun.lock'), 'utf8'))
    lock.packages.unrelated = ['unrelated@1.2.3', origin, {}, 'sha512-fixture']
    const registry = 'https://registry.example.invalid'
    expect(() => assertRegistryLock(JSON.stringify(lock), registry)).toThrow(expect.objectContaining({
      code: 'registry_guard', packageName: 'unrelated', field: 'bun.lock.packages.unrelated.registry',
    }))
    if (origin.includes('user:secret@')) {
      lock.packages.unrelated[1] = origin.replace('user:secret@', '')
      expect(assertRegistryLock(JSON.stringify(lock), registry)).toEqual(lock)
    }
  },
)
it('accepts only configured registry origins, including an explicit matching transitive archive URL', async () => {
  const lock = JSON.parse(await readFile(join(fixture.root, 'bun.lock'), 'utf8'))
  lock.packages.unrelated = ['unrelated@1.2.3', `${fixture.registry}/unrelated/-/unrelated-1.2.3.tgz`, {}, 'sha512-fixture']
  expect(assertRegistryLock(JSON.stringify(lock), fixture.registry).packages.unrelated[1]).toContain(fixture.registry)
  expect(() => assertRegistryLock(JSON.stringify(lock))).toThrow(expect.objectContaining({ code: 'registry_guard' }))
})

it('resolves all coordinated packages and verifies local installed binary bytes', async () => {
  const sdk = await resolveRegistrySdk(fixture.version, fixture.registry)
  expect(sdk.packages).toEqual(fixture.packages)
  expect((await verify()).packages).toHaveLength(3)
})
it.each(['missing', 'version', 'integrity'])('rejects invalid metadata: %s', async mode => {
  fixture.mode(mode)
  await expect(resolveRegistrySdk(fixture.version, fixture.registry)).rejects.toMatchObject({ code: 'registry_metadata' })
})
it('bounds metadata body reads and supports caller cancellation', async () => {
  fixture.mode('slow')
  await expect(resolveRegistrySdk(fixture.version, fixture.registry, { timeoutMs: 40 })).rejects.toMatchObject({ code: 'registry_metadata' })
  const controller = new AbortController()
  const pending = resolveRegistrySdk(fixture.version, fixture.registry, { signal: controller.signal })
  controller.abort()
  await expect(pending).rejects.toMatchObject({ code: 'registry_metadata' })
})
it('downloads integrity-bound archive witnesses and bounds response sizes', async () => {
  const sdk = await resolveRegistrySdk(fixture.version, fixture.registry)
  const witnesses = await downloadRegistryArchives(sdk, join(fixture.base, 'download'))
  expect(witnesses).toHaveLength(3)
  expect(witnesses[0]).toMatchObject({ name: fixture.packages[0].name, sha256: expect.stringMatching(/^[a-f0-9]{64}$/), sha512: expect.stringMatching(/^[a-f0-9]{128}$/) })
  await expect(downloadRegistryArchives(sdk, join(fixture.base, 'tiny'), { maxBytes: 1 })).rejects.toMatchObject({ code: 'registry_integrity' })
  sdk.packages[0].integrity = 'sha512-' + Buffer.alloc(64).toString('base64')
  await expect(downloadRegistryArchives(sdk, join(fixture.base, 'invalid'))).rejects.toMatchObject({ code: 'registry_integrity' })
})
it('rejects archive substitution even when installed bytes match the substitute', async () => {
  await fixture.substitute()
  await expect(verify()).rejects.toMatchObject({ code: 'registry_integrity' })
})
it.each(['workspace:*', 'file:../producer.tgz', 'link:../producer', '../producer', '/tmp/producer', 'C:\\producer'])('rejects local manifest references: %s', async value => {
  const path = join(fixture.root, 'package.json'), manifest = JSON.parse(await readFile(path, 'utf8'))
  manifest.dependencies.unrelated = value
  await writeFile(path, JSON.stringify(manifest))
  await expect(verify()).rejects.toMatchObject({ code: 'registry_guard' })
})
it.each(['workspace:*', 'file:../producer.tgz', 'link:../producer'])('rejects local lock references: %s', async value => {
  const path = join(fixture.root, 'bun.lock'), lock = JSON.parse(await readFile(path, 'utf8'))
  lock.packages.unrelated = [`unrelated@${value}`, '', {}, 'sha512-fixture']
  await writeFile(path, JSON.stringify(lock))
  await expect(verify()).rejects.toMatchObject({ code: 'registry_guard' })
})
it('rejects nested SDK resolutions, including the same version', async () => {
  const path = join(fixture.root, 'bun.lock'), lock = JSON.parse(await readFile(path, 'utf8'))
  lock.packages['unrelated/@workbasehq/core'] = lock.packages['@workbasehq/core']
  await writeFile(path, JSON.stringify(lock))
  await expect(verify()).rejects.toMatchObject({ code: 'registry_integrity' })
})
it('rejects a nested SDK directory omitted from the lock graph', async () => {
  await mkdir(join(fixture.root, 'node_modules/unrelated/node_modules/@workbasehq/core'), { recursive: true })
  await expect(verify()).rejects.toMatchObject({ code: 'registry_integrity' })
})
it.each(['dist', 'dist/lib', '.hidden/dist', 'node_modules/other/dist'])('rejects SDK resolution from a package subdirectory: %s', async subdirectory => {
  const directory = join(fixture.root, 'node_modules/unrelated', subdirectory)
  const nested = join(directory, 'node_modules/@workbasehq/core')
  await mkdir(nested, { recursive: true })
  await writeFile(join(nested, 'package.json'), JSON.stringify({ name: '@workbasehq/core', version: fixture.version, main: 'index.js' }))
  await writeFile(join(nested, 'index.js'), 'module.exports = 99')
  expect(createRequire(join(directory, 'index.js')).resolve('@workbasehq/core')).toBe(await realpath(join(nested, 'index.js')))
  await expect(verify()).rejects.toMatchObject({ code: 'registry_integrity', message: expect.stringContaining(`node_modules/unrelated/${subdirectory}/node_modules/@workbasehq/core`) })
})
it.each([
  'node_modules/@WORKBASEHQ/core',
  'NODE_MODULES/@workbasehq/core',
  'Node_Modules/@WorkbaseHQ/plugins',
  'NODE_MODULES/@WORKBASEHQ/CORE',
])('rejects case-variant nested SDK paths on every filesystem: %s', async layout => {
  const directory = join(fixture.root, 'node_modules/unrelated/dist'), nested = join(directory, layout)
  await mkdir(nested, { recursive: true })
  // Fresh parents preserve each requested spelling, without relying on aliases
  // resolving on the host filesystem or creating case-colliding siblings.
  const [modules, scope, name] = layout.split('/')
  expect(await readdir(directory)).toEqual([modules])
  expect(await readdir(join(directory, modules))).toEqual([scope])
  expect(await readdir(join(directory, modules, scope))).toEqual([name])
  await writeFile(join(nested, 'package.json'), JSON.stringify({ name: `@workbasehq/${name.toLowerCase()}`, version: fixture.version, main: 'index.js' }))
  await writeFile(join(nested, 'index.js'), 'module.exports = 99')
  expect(createRequire(join(directory, 'index.js'))(nested)).toBe(99)
  await expect(verify()).rejects.toMatchObject({ code: 'registry_integrity', message: expect.stringContaining(`neočekávané vnořené SDK: node_modules/unrelated/dist/${layout}.`) })
})
it('normalizes nested SDK scope names to NFC before ASCII case folding', async () => {
  const directory = join(fixture.root, 'node_modules/unrelated/dist/node_modules')
  // U+212A KELVIN SIGN has the canonical NFC form ASCII K.
  await mkdir(join(directory, '@wor\u212Abasehq/core'), { recursive: true })
  const [scope] = await readdir(directory)
  await expect(verify()).rejects.toMatchObject({ code: 'registry_integrity', message: expect.stringContaining(`neočekávané vnořené SDK: node_modules/unrelated/dist/node_modules/${scope}/core.`) })
})
it('rejects a case-variant top-level scope instead of treating it as the verified path', async () => {
  const modules = join(fixture.root, 'node_modules')
  // An intermediate name also makes a case-only rename portable.
  await rename(join(modules, '@workbasehq'), join(modules, 'scope-temp'))
  await rename(join(modules, 'scope-temp'), join(modules, '@WORKBASEHQ'))
  await expect(verify()).rejects.toMatchObject({ code: 'registry_integrity' })
})
it.each(['sdk', 'outside'])('rejects a symlink in a package subdirectory: %s', async target => {
  const directory = join(fixture.root, 'node_modules/unrelated/dist')
  await mkdir(directory, { recursive: true })
  await symlink(target === 'sdk' ? '../../@workbasehq/core' : fixture.base, join(directory, 'linked'))
  await expect(verify()).rejects.toMatchObject({ code: 'registry_guard', message: expect.stringContaining('node_modules/unrelated/dist/linked') })
})
it('rejects a symlinked nested SDK directory', async () => {
  const scope = join(fixture.root, 'node_modules/unrelated/dist/node_modules/@workbasehq')
  await mkdir(scope, { recursive: true })
  await symlink(join(fixture.root, 'node_modules/@workbasehq/core'), join(scope, 'core'))
  await expect(verify()).rejects.toMatchObject({ code: 'registry_integrity', message: expect.stringContaining('node_modules/unrelated/dist/node_modules/@workbasehq/core') })
})
it('fails closed when the installed layout exceeds its depth cap', async () => {
  await mkdir(join(fixture.root, 'node_modules/unrelated', ...Array(65).fill('deep')), { recursive: true })
  await expect(verify()).rejects.toMatchObject({ code: 'registry_guard', message: expect.stringMatching(/depth.*limit/i) })
})
it('fails closed when the installed layout exceeds its entry cap', async () => {
  const directory = join(fixture.root, 'node_modules/unrelated')
  await mkdir(directory)
  await writeFile(join(directory, 'file'), '')
  const open = vi.mocked(opendir).getMockImplementation()!
  // Present a wide directory without allocating 100,001 fixture files on disk.
  vi.mocked(opendir).mockImplementation(async (...args) => args[0] === directory ? {
    async *[Symbol.asyncIterator]() { for (let i = 0; i < 100001; i++) yield { name: 'file' } },
  } as Awaited<ReturnType<typeof opendir>> : open(...args))
  try {
    await expect(verify()).rejects.toMatchObject({ code: 'registry_guard', message: expect.stringMatching(/entry.*limit/i) })
  } finally { vi.mocked(opendir).mockImplementation(open) }
})
it('permits ordinary package-manager bin links to files inside the install', async () => {
  await mkdir(join(fixture.root, 'node_modules/.bin'))
  await symlink('../@workbasehq/core/binary.dat', join(fixture.root, 'node_modules/.bin/fixture'))
  expect((await verify()).status).toBe('pass')
})
it.each(['directory', 'outside', 'chain'])('fails closed on unsafe package-manager bin links: %s', async target => {
  const bin = join(fixture.root, 'node_modules/.bin')
  await mkdir(bin)
  if (target === 'chain') await symlink('../@workbasehq/core/binary.dat', join(bin, 'alias'))
  await symlink(target === 'directory' ? '../@workbasehq/core' : target === 'outside' ? fixture.base : 'alias', join(bin, 'fixture'))
  await expect(verify()).rejects.toMatchObject({ code: 'registry_guard' })
})
it('rejects lock integrity drift', async () => {
  const path = join(fixture.root, 'bun.lock'), lock = JSON.parse(await readFile(path, 'utf8'))
  lock.packages['@workbasehq/core'][3] = fixture.packages[1].integrity
  await writeFile(path, JSON.stringify(lock))
  await expect(verify()).rejects.toMatchObject({ code: 'registry_integrity' })
})
it('parses Bun JSONC under Node without altering strings or legitimate bin paths', async () => {
  const path = join(fixture.root, 'bun.lock'), lock = JSON.parse(await readFile(path, 'utf8'))
  lock.packages.unrelated = ['unrelated@1.0.0', '', { bin: './literal,} //text' }, 'sha512-fixture']
  await writeFile(path, '// local lock\n' + JSON.stringify(lock).slice(0, -1) + ', /* trailing comma */ }')
  expect((await verify()).status).toBe('pass')
})
it.each(['workspace:*', 'file:../producer.tgz', 'link:../producer'])('rejects installed manifest references: %s', async value => {
  const path = join(fixture.root, 'node_modules/@workbasehq/core/package.json'), manifest = JSON.parse(await readFile(path, 'utf8'))
  manifest.optionalDependencies = { unrelated: value }
  await writeFile(path, JSON.stringify(manifest))
  await expect(verify()).rejects.toMatchObject({ code: 'registry_guard' })
})
it('bounds archive body reads and cancels downloads', async () => {
  const sdk = await resolveRegistrySdk(fixture.version, fixture.registry)
  fixture.mode('slow')
  await expect(downloadRegistryArchives(sdk, join(fixture.base, 'slow'), { timeoutMs: 40 })).rejects.toMatchObject({ code: 'registry_integrity' })
  const controller = new AbortController()
  const pending = downloadRegistryArchives(sdk, join(fixture.base, 'cancelled'), { signal: controller.signal })
  controller.abort()
  await expect(pending).rejects.toMatchObject({ code: 'registry_integrity' })
})
