import { registerTempDir, cleanupTempDir } from './lib/test-temp-dir.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertSdkArchives, assertSdkPackageNames, sdkArchives, sdkSource, writeSdkProvenance } from './sdk-provenance'

const assetFiles = ['index.html', 'assets/console.js', 'assets/console.css', 'locales/en.json', 'locales/cs.json', 'build-meta.json', 'LICENSE', 'NOTICE', 'assets/Alata-Regular.ttf', 'licenses/alata/OFL.txt']
const assetPath = (file: string) => `packages/plugins/console/assets/${file}`

function withSourceRepository(run: (root: string, git: (args: string[]) => string) => void) {
  const root = registerTempDir(mkdtempSync(join(tmpdir(), 'sdk-source-')))
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  try {
    git(['init', '--quiet'])
    for (const directory of ['packages/core/src', 'packages/plugins/console/src', 'examples', 'instances', 'apps', 'dist-sdk']) {
      mkdirSync(join(root, directory), { recursive: true })
    }
    // Use the checkout's real ignore policy so this catches generated-path regressions.
    writeFileSync(join(root, '.gitignore'), readFileSync(join(import.meta.dirname, '../.gitignore')))
    writeFileSync(join(root, 'LICENSE'), 'fixture license\n')
    writeFileSync(join(root, 'tsconfig.json'), '{}\n')
    writeFileSync(join(root, 'packages/core/src/index.ts'), 'export const value = 1\n')
    writeFileSync(join(root, 'packages/plugins/console/src/index.ts'), 'export {}\n')
    git(['add', '.'])
    git(['-c', 'user.name=SDK Test', '-c', 'user.email=sdk-test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture'])
    assert.equal(git(['status', '--porcelain', '--untracked-files=all']), '')
    assert.equal(sdkSource(root).dirty, false)
    run(root, git)
  } finally { cleanupTempDir(root) }
}

function stageAssets(root: string) {
  for (const file of assetFiles) {
    const path = join(root, assetPath(file))
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, file === 'assets/Alata-Regular.ttf' || file === 'licenses/alata/OFL.txt'
      ? readFileSync(join(import.meta.dirname, '../packages/ui/src/assets/fonts', file.split('/').at(-1)!))
      : `fixture payload: ${file}\n`)
  }
}

test('staged ignored console assets stay clean and every payload contributes to provenance', () => {
  withSourceRepository((root, git) => {
    const before = sdkSource(root)
    stageAssets(root)
    const source = sdkSource(root)
    assert.equal(source.dirty, false)
    assert.equal(git(['status', '--porcelain', '--untracked-files=all']), '')
    assert.equal(source.sourceCommit, git(['rev-parse', 'HEAD']))
    assert.notEqual(source.contentHash, before.contentHash)
    for (const file of assetFiles) {
      assert.ok(source.inputFiles.includes(assetPath(file)), file)
      const path = join(root, assetPath(file)), original = readFileSync(path)
      writeFileSync(path, 'changed ignored payload\n')
      assert.notEqual(sdkSource(root).contentHash, source.contentHash, file)
      writeFileSync(path, original)
    }
    assert.deepEqual(writeSdkProvenance(root, source), { version: 1, ...source, archives: [] })
    assert.equal(JSON.parse(readFileSync(join(root, 'dist-sdk/PROVENANCE.json'), 'utf8')).dirty, false)
    assert.equal(git(['status', '--porcelain', '--untracked-files=all']), '')
  })
})

for (const change of ['tracked edit', 'staged edit', 'tracked deletion', 'unrelated untracked file']) {
  test(`ignored console assets do not hide a ${change}`, () => {
    withSourceRepository((root, git) => {
      stageAssets(root)
      assert.equal(sdkSource(root).dirty, false)
      const tracked = 'packages/core/src/index.ts'
      if (change === 'tracked deletion') rmSync(join(root, tracked))
      else if (change === 'unrelated untracked file') writeFileSync(join(root, 'unrelated.txt'), 'untracked\n')
      else {
        writeFileSync(join(root, tracked), 'export const value = 2\n')
        if (change === 'staged edit') git(['add', tracked])
      }
      assert.equal(sdkSource(root).dirty, true)
    })
  })
}

test('console assets ignore rule is anchored to the repository root', () => {
  withSourceRepository((root) => {
    const nested = join(root, 'examples/demo', assetPath('index.html'))
    mkdirSync(join(nested, '..'), { recursive: true })
    writeFileSync(nested, 'unrelated untracked file\n')
    assert.equal(sdkSource(root).dirty, true)
  })
})

test('provenance rejects an ignored payload mutated after capture', () => {
  withSourceRepository((root, git) => {
    stageAssets(root)
    const source = sdkSource(root)
    writeFileSync(join(root, assetPath('assets/console.js')), 'changed after capture\n')
    assert.equal(git(['status', '--porcelain', '--untracked-files=all']), '')
    assert.equal(sdkSource(root).dirty, false)
    assert.throws(() => writeSdkProvenance(root, source), /Vstupy SDK se během balení změnily/)
    assert.equal(existsSync(join(root, 'dist-sdk/PROVENANCE.json')), false)
  })
})

test('plugins pack includes ignored console payloads with the release manifest files policy', () => {
  withSourceRepository((root) => {
    stageAssets(root)
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '../packages/plugins/package.json'), 'utf8'))
    // Match stageConsolePackage's producer-only manifest removals without running a build.
    delete manifest.scripts
    delete manifest.devDependencies
    writeFileSync(join(root, 'packages/plugins/package.json'), JSON.stringify(manifest))
    const directory = join(root, 'dist-sdk')
    execFileSync('bun', ['pm', 'pack', '--destination', directory, '--quiet'], { cwd: join(root, 'packages/plugins') })
    const archives = sdkArchives(directory)
    assert.equal(archives.length, 1)
    const archive = join(directory, archives[0].name)
    const members = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n')
    for (const file of assetFiles) {
      const member = `package/console/assets/${file}`
      assert.ok(members.includes(member), member)
      assert.deepEqual(execFileSync('tar', ['-xOf', archive, member]), readFileSync(join(root, assetPath(file))))
    }
  })
})

const expected = ['@workbasehq/core', '@workbasehq/plugins', '@workbasehq/mcp']
test('requires exactly the three SDK manifest identities, regardless of order', () => {
  assert.doesNotThrow(() => assertSdkPackageNames([...expected].reverse()))
  for (const names of [[], expected.slice(1), [...expected, '@workbasehq/ui'], [expected[0], expected[0], expected[2]], [expected[0], expected[1], '@workbasehq/ui']]) {
    assert.throws(() => assertSdkPackageNames(names), /expected exactly SDK packages/)
  }
})

test('packer archive assertion reads manifest identities and rejects extra, missing or substituted archives', () => {
  const root = registerTempDir(mkdtempSync(join(tmpdir(), 'sdk-archives-')))
  const directory = join(root, 'dist-sdk')
  try {
    mkdirSync(directory)
    mkdirSync(join(root, 'package'))
    const pack = (file: string, name: string) => {
      writeFileSync(join(root, 'package/package.json'), JSON.stringify({ name }))
      execFileSync('tar', ['-czf', join(directory, file), '-C', root, 'package'])
    }
    expected.forEach((name, index) => pack(`${index}.tgz`, name))
    assert.doesNotThrow(() => assertSdkArchives(directory))
    pack('extra.tgz', '@workbasehq/ui')
    assert.throws(() => assertSdkArchives(directory), /expected exactly SDK packages/)
    rmSync(join(directory, 'extra.tgz'))
    rmSync(join(directory, '2.tgz'))
    assert.throws(() => assertSdkArchives(directory), /expected exactly SDK packages/)
    pack('2.tgz', '@workbasehq/core')
    assert.throws(() => assertSdkArchives(directory), /expected exactly SDK packages/)
    pack('2.tgz', '@workbasehq/ui')
    assert.throws(() => assertSdkArchives(directory), /expected exactly SDK packages/)
  } finally { cleanupTempDir(root) }
})

test('canonical MCP docs and copier inputs participate in the source fingerprint', () => {
  withSourceRepository((root) => {
    const paths = ['docs/sdk/getting-started.md', 'docs/sdk/mcp-composition.md', 'docs/sdk/migration-0.4.0.md', 'docs/sdk/onboarding.md',
      'scripts/lib/stage-mcp-docs.ts', 'packages/mcp/src/doc-manifest.ts']
    for (const file of paths) {
      mkdirSync(join(root, file, '..'), { recursive: true })
      writeFileSync(join(root, file), 'original\n')
    }
    const before = sdkSource(root)
    for (const file of paths) {
      assert.ok(before.inputFiles.includes(file), file)
      writeFileSync(join(root, file), 'original!\n')
      assert.notEqual(sdkSource(root).contentHash, before.contentHash, file)
      writeFileSync(join(root, file), 'original\n')
    }
  })
})

test('MCP release copier and files policy pack exactly byte-identical allowlisted docs', async () => {
  const { stageMcpDocs } = await import('./lib/stage-mcp-docs.ts')
  withSourceRepository((root) => {
    const destination = join(root, 'packages/mcp')
    mkdirSync(destination, { recursive: true })
    const canonical = join(import.meta.dirname, '../docs/sdk')
    const names = ['getting-started.md', 'mcp-composition.md', 'migration-0.4.0.md', 'onboarding.md']
    mkdirSync(join(root, 'docs/sdk'), { recursive: true })
    for (const name of [...names, 'release.md']) writeFileSync(join(root, 'docs/sdk', name), readFileSync(join(canonical, name)))
    // Staging replaces stale output instead of accidentally shipping an old document.
    mkdirSync(join(destination, 'docs'))
    writeFileSync(join(destination, 'docs/stale.md'), 'not allowlisted')
    stageMcpDocs(root, destination)
    cpSync(join(import.meta.dirname, '../packages/mcp/src'), join(destination, 'src'), { recursive: true })
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '../packages/mcp/package.json'), 'utf8'))
    delete manifest.scripts; delete manifest.dependencies
    writeFileSync(join(destination, 'package.json'), JSON.stringify(manifest))
    execFileSync('npm', ['pack', '--pack-destination', join(root, 'dist-sdk'), '--ignore-scripts', '--offline', '--quiet'], { cwd: destination })
    const archive = join(root, 'dist-sdk', sdkArchives(join(root, 'dist-sdk'))[0].name)
    const docs = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n').filter(path => path.startsWith('package/docs/'))
    assert.deepEqual(docs.sort(), names.map(name => `package/docs/${name}`).sort())
    for (const name of names) assert.deepEqual(execFileSync('tar', ['-xOf', archive, `package/docs/${name}`]), readFileSync(join(canonical, name)))
    const extracted = join(root, 'extracted')
    mkdirSync(extracted)
    execFileSync('tar', ['-xzf', archive, '-C', extracted])
    symlinkSync(join(import.meta.dirname, '../packages/mcp/node_modules'), join(extracted, 'package/node_modules'))
    mkdirSync(join(root, 'empty-instance'))
    const result = JSON.parse(execFileSync('bun', ['-e', `
      const {createServer} = await import(${JSON.stringify(join(extracted, 'package/src/server.ts'))});
      const {createRequire} = await import('node:module');
      const require = createRequire(${JSON.stringify(join(extracted, 'package/package.json'))});
      const {Client} = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'));
      const {InMemoryTransport} = await import(require.resolve('@modelcontextprotocol/sdk/inMemory.js'));
      const app = await createServer({root: ${JSON.stringify(join(root, 'empty-instance'))}});
      const client = new Client({name:'example', version:'1'});
      const [a,b] = InMemoryTransport.createLinkedPair();
      try {
        await app.server.connect(b); await client.connect(a);
        const tools = (await client.listTools()).tools.map(tool => tool.name);
        const list = (await client.callTool({name:'list_docs', arguments:{}})).structuredContent;
        const read = (await client.callTool({name:'read_doc', arguments:{name:'mcp-composition.md'}})).structuredContent;
        console.log(JSON.stringify({tools, list, read}));
      } finally { await client.close(); await app.server.close() }
    `], { encoding: 'utf8' }))
    assert.ok(result.tools.includes('list_docs'))
    assert.ok(result.tools.includes('read_doc'))
    assert.equal(result.list.ok, true)
    assert.equal(result.list.version, manifest.version)
    assert.equal(result.list.docs.length, 4)
    assert.equal(result.read.ok, true)
    assert.equal(result.read.content, readFileSync(join(canonical, 'mcp-composition.md'), 'utf8'))
  })
})
