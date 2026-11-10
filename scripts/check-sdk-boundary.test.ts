import { afterEach, expect, it, vi } from 'vitest'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import catalog from '../packages/core/src/query/enum-labels.json'
import { assertCoreEnumLabels } from './check-core-enum-labels'
import { sdkPackageNames } from './sdk-provenance'
import { checkSdkBoundary as checkBoundary } from './check-sdk-boundary'
import { instanceNames as baseInstanceNames } from './lib/public-vocabulary'
import { assertGeneratedMcpContent } from './lib/check-generated-mcp'

const syntheticTerms = ['quartzbeacon', 'cobalt-gateway', 'Žlutý signál']
const instanceNames = new RegExp([baseInstanceNames.source, `(?<![\\p{L}\\p{N}_])(?:${syntheticTerms.join('|')})(?![\\p{L}\\p{N}_])`].join('|'), 'iu')
const checkSdkBoundary = (root: string) => checkBoundary(root, false, instanceNames)

let scratch: string | undefined
afterEach(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); vi.restoreAllMocks() })

it('ships labels only for core-declared enum values', () => {
  expect(() => assertCoreEnumLabels(catalog)).not.toThrow()
  // Unknown keys must fail even when they do not match the vocabulary scan.
  expect(() => assertCoreEnumLabels({ en: { ...catalog.en, value_custom: 'Custom' } })).toThrow('Non-core enum label: en.value_custom')
})

const knownBadSnippets = [
  "label: 'quartzbeacon'", "label: 'QUARTZBEACON'", "label: 'cobalt-gateway'",
  "const label = 'cobalt-gateway'", "label: 'Žlutý signál'",
  "label: 'quArtzbeacon'", "label: 'cobalt-gateway\u0301'",
]

it.each([
  'const fieldId = 1', 'const member_name = "value"', 'const quartzbeaconish = true',
  'const unrelated = true', 'const cobaltGateway = true', "label: 'cobalt/gateway'", "label: 'cobalt_gateway'", 'const quartzbeaconId = 1', 'const getQuartzbeacon = true',
])('does not flag generic code or partial words: %s', source => {
  expect(instanceNames.test(source)).toBe(false)
})

it('rejects independent known-bad snippets and every forbidden term in packed archives', () => {
  scratch = mkdtempSync(join(tmpdir(), 'sdk-boundary-test-'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  for (const group of ['packages/core/src', 'examples', 'instances', 'apps', 'dist-sdk']) mkdirSync(join(scratch, group), { recursive: true })
  const stage = join(scratch, 'stage'), pkg = join(stage, 'package')
  mkdirSync(join(pkg, 'src/query'), { recursive: true })
  writeFileSync(join(pkg, 'src/query/enum-labels.json'), JSON.stringify(catalog))
  writeFileSync(join(pkg, 'src/probe.ts'), '// Neutral source\n')
  for (const name of sdkPackageNames) {
    if (name === 'plugins') {
      mkdirSync(join(pkg, 'console/assets'), { recursive: true })
      writeFileSync(join(pkg, 'console/assets/index.js'), 'console.log("generic console")\n')
    }
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: `@workbasehq/${name}` }))
    execFileSync('tar', ['-czf', join(scratch, `dist-sdk/${name}.tgz`), '-C', stage, 'package'])
  }
  const archive = join(scratch, 'dist-sdk/core.tgz'), original = join(scratch, 'original.tgz')
  cpSync(archive, original)
  expect(checkSdkBoundary(scratch)).toBe(0)
  for (const term of syntheticTerms) {
    // Start each injection with the same clean packed archive, then restore it.
    execFileSync('tar', ['-xzf', original, '-C', stage])
    for (const spelling of [term, term.toUpperCase()]) {
      writeFileSync(join(pkg, 'src/probe.ts'), `// ${spelling}\n`)
      execFileSync('tar', ['-czf', archive, '-C', stage, 'package'])
      errors.mockClear()
      expect(checkSdkBoundary(scratch), spelling).toBe(1)
      expect(errors.mock.calls.flat().join('\n'), spelling).toContain('instance data: core.tgz: src/probe.ts')
    }
    cpSync(original, archive)
    expect(checkSdkBoundary(scratch), `restored ${term}`).toBe(0)
  }
  const pluginsArchive = join(scratch, 'dist-sdk/plugins.tgz')
  const originalPlugins = join(scratch, 'original-plugins.tgz')
  cpSync(pluginsArchive, originalPlugins)
  for (const snippet of knownBadSnippets) {
    execFileSync('tar', ['-xzf', originalPlugins, '-C', stage])
    mkdirSync(join(pkg, 'members/src'), { recursive: true })
    writeFileSync(join(pkg, 'members/src/mail.ts'), `export const labels = { ${snippet} }\n`)
    execFileSync('tar', ['-czf', pluginsArchive, '-C', stage, 'package'])
    errors.mockClear()
    expect(checkSdkBoundary(scratch), snippet).toBe(1)
    expect(errors.mock.calls.flat().join('\n'), snippet).toContain('instance data: plugins.tgz: members/src/mail.ts')
    cpSync(originalPlugins, pluginsArchive)
    expect(checkSdkBoundary(scratch), `restored ${snippet}`).toBe(0)
  }
  // Check the structural guard against an actual packed JSON mutation too.
  execFileSync('tar', ['-xzf', original, '-C', stage])
  const path = join(pkg, 'src/query/enum-labels.json')
  const modified = JSON.parse(readFileSync(path, 'utf8'))
  modified.en.value_custom = 'Custom'
  writeFileSync(path, JSON.stringify(modified))
  execFileSync('tar', ['-czf', archive, '-C', stage, 'package'])
  errors.mockClear()
  expect(checkSdkBoundary(scratch)).toBe(1)
  expect(errors.mock.calls.flat().join('\n')).toContain('Non-core enum label: en.value_custom')
  cpSync(original, archive)
  expect(checkSdkBoundary(scratch)).toBe(0)
}, 30000)


it('checks template tooling against its own manifest without allowing undeclared SDK runtime imports', () => {
  scratch = mkdtempSync(join(tmpdir(), 'sdk-template-boundary-'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  for (const group of ['packages/core/src', 'examples', 'instances', 'apps', 'dist-sdk']) mkdirSync(join(scratch, group), { recursive: true })
  const stage = join(scratch, 'stage'), pkg = join(stage, 'package')
  mkdirSync(join(pkg, 'src/query'), { recursive: true })
  writeFileSync(join(pkg, 'src/query/enum-labels.json'), JSON.stringify(catalog))
  for (const name of sdkPackageNames) {
    if (name === 'plugins') {
      mkdirSync(join(pkg, 'console/assets'), { recursive: true })
      writeFileSync(join(pkg, 'console/assets/index.js'), 'console.log("generic console")\n')
    }
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: `@workbasehq/${name}`, devDependencies: { typescript: '5.7.2' } }))
    execFileSync('tar', ['-czf', join(scratch, `dist-sdk/${name}.tgz`), '-C', stage, 'package'])
  }
  const template = join(pkg, 'templates/standalone')
  mkdirSync(join(template, 'scripts'), { recursive: true })
  writeFileSync(join(template, 'package.json'), JSON.stringify({ private: true, devDependencies: { typescript: '5.7.2' } }))
  const probe = join(template, 'scripts/typecheck.ts')
  const pack = () => execFileSync('tar', ['-czf', join(scratch!, 'dist-sdk/mcp.tgz'), '-C', stage, 'package'])
  writeFileSync(probe, "import ts from 'typescript'\n")
  pack()
  expect(checkSdkBoundary(scratch)).toBe(0)
  writeFileSync(probe, "import ts from 'undeclared-tool'\n")
  pack()
  expect(checkSdkBoundary(scratch)).toBe(1)
  expect(errors.mock.calls.flat().join('\n')).toContain('undeclared runtime dependency: scripts/typecheck.ts: undeclared-tool')
  writeFileSync(probe, "import ts from 'typescript'\n")
  writeFileSync(join(pkg, 'src/probe.ts'), "import ts from 'typescript'\n")
  pack()
  errors.mockClear()
  expect(checkSdkBoundary(scratch)).toBe(1)
  expect(errors.mock.calls.flat().join('\n')).toContain('undeclared runtime dependency: src/probe.ts: typescript')
})

// Exercise the complete boundary in both checkout layouts, including archive identity.
it.each([false, true])('keeps workspace and tarball guards strict with private groups present=%s', privateGroups => {
  scratch = mkdtempSync(join(tmpdir(), 'sdk-boundary-layout-'))
  const logs = vi.spyOn(console, 'log').mockImplementation(() => {})
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  for (const path of ['packages/core/src', 'dist-sdk', 'stage/package/src/query']) mkdirSync(join(scratch, path), { recursive: true })
  if (privateGroups) for (const group of ['examples', 'instances', 'apps']) mkdirSync(join(scratch, group), { recursive: true })
  const stage = join(scratch, 'stage'), pkg = join(stage, 'package')
  writeFileSync(join(pkg, 'src/query/enum-labels.json'), JSON.stringify(catalog))
  mkdirSync(join(pkg, 'console/assets'), { recursive: true })
  writeFileSync(join(pkg, 'console/assets/index.js'), 'console.log("generic console")\n')
  writeFileSync(join(pkg, 'src/generic.ts'), '// Zod instances/lazy caches remain generic.\n')
  const pack = (file: string, name: string) => {
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name }))
    execFileSync('tar', ['-czf', join(scratch!, 'dist-sdk', file), '-C', stage, 'package'])
  }
  for (const name of ['core', 'plugins', 'mcp']) pack(`${name}.tgz`, `@workbasehq/${name}`)
  expect(checkSdkBoundary(scratch)).toBe(0)
  expect(logs.mock.calls.flat().filter(message => String(message).includes('skipping absent private group'))).toHaveLength(privateGroups ? 0 : 3)
  pack('extra.tgz', '@workbasehq/ui')
  expect(checkSdkBoundary(scratch)).toBe(1)
  rmSync(join(scratch, 'dist-sdk/extra.tgz'))
  rmSync(join(scratch, 'dist-sdk/mcp.tgz'))
  expect(checkSdkBoundary(scratch)).toBe(1)
  for (const name of ['@workbasehq/core', '@workbasehq/ui']) {
    pack('mcp.tgz', name)
    errors.mockClear()
    expect(checkSdkBoundary(scratch)).toBe(1)
    expect(errors.mock.calls.flat().join('\n')).toContain('expected exactly SDK packages')
  }
  pack('mcp.tgz', '@workbasehq/mcp')
  for (const name of ['core', 'plugins', 'mcp']) {
    for (const content of ['// quartzbeacon', '// ../../instances/neutral/config.ts', '// ../../examples/neutral/config.ts', '// ../../apps/neutral/config.ts']) {
      writeFileSync(join(pkg, 'src/probe.ts'), content + '\n')
      pack(`${name}.tgz`, `@workbasehq/${name}`)
      expect(checkSdkBoundary(scratch), `${name}: ${content}`).toBe(1)
      rmSync(join(pkg, 'src/probe.ts'))
      pack(`${name}.tgz`, `@workbasehq/${name}`)
    }
    mkdirSync(join(pkg, 'instances'), { recursive: true })
    writeFileSync(join(pkg, 'instances/neutral.json'), '{}\n')
    pack(`${name}.tgz`, `@workbasehq/${name}`)
    expect(checkSdkBoundary(scratch)).toBe(1)
    rmSync(join(pkg, 'instances'), { recursive: true })
    pack(`${name}.tgz`, `@workbasehq/${name}`)
  }
  expect(checkSdkBoundary(scratch)).toBe(0)
  if (privateGroups) {
    mkdirSync(join(scratch, 'instances/neutral'), { recursive: true })
    writeFileSync(join(scratch, 'instances/neutral/package.json'), JSON.stringify({ name: '@private/neutral' }))
    expect(checkSdkBoundary(scratch)).toBe(1)
    expect(errors.mock.calls.flat().join('\n')).toContain('non-SDK workspace must be private: instances/neutral/package.json')
  }
})

it('scans generated MCP template content and paths with ordinary regexes', () => {
  const path = 'generated/scripts/typecheck.ts'
  expect(() => assertGeneratedMcpContent(path, 'export const label = "field_name"', instanceNames)).not.toThrow()
  for (const term of syntheticTerms) {
    expect(() => assertGeneratedMcpContent(path, `export const label = ${JSON.stringify(term)}`, instanceNames)).toThrow('Forbidden generated content')
    expect(() => assertGeneratedMcpContent(`generated/${term}.ts`, '// Clean content', instanceNames)).not.toThrow()
  }
  expect(() => assertGeneratedMcpContent(path, '{{SDK_VERSION}}', instanceNames)).toThrow('Unresolved placeholder')
})
