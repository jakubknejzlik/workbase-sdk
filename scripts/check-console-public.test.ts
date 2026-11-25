import { registerTempDir, cleanupTempDir } from './lib/test-temp-dir.mjs'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { consolePrivateTerms, reviewDigest } from './lib/public-vocabulary'
import { checkConsolePublic, privateLocaleKeys } from './check-console-public'
import { inspectSource } from './check-terminology'
import { execFileSync } from 'node:child_process'
import policy from './sdk-scan-policy.json'
import { assertBytes, withPolicyDataReviews } from './lib/sdk-export-scan'

afterEach(() => vi.unstubAllEnvs())
const syntheticTerms = ['quartzbeacon', 'cobalt-gateway', 'Žlutý signál']
const vocabulary = new RegExp([consolePrivateTerms.source, ...syntheticTerms, 'secret_'].join('|'), 'iu')
const scan = (directory: string) => checkConsolePublic(directory, vocabulary)
it.each(['en', 'cs'])('91 %s Console catalog passes the terminology gate', language => {
  const file = `packages/frontend-console/src/locales/${language}.json`
  expect(inspectSource(file, readFileSync(resolve(import.meta.dirname, '..', file), 'utf8'))).toEqual([])
})
it.each(['page.tsx', 'packages/frontend-console/dist/assets/index.js'])('terminology accepts the preserved members path in %s', file => {
  expect(inspectSource(file, "const page = { path: '/settings/workspace-members' }")).toEqual([])
})
it.each([
  ['JSX text', 'page.tsx', 'const page = <span>/settings/workspace-members</span>'],
  ['label', 'page.tsx', "const page = { label: '/settings/workspace-members' }"],
  ['locale value', 'en.json', '{"members":"/settings/workspace-members"}'],
])('terminology rejects the preserved members path as %s', (_kind, file, source) => {
  expect(inspectSource(file, source)).toContainEqual({ code: 'terminology_forbidden', location: expect.any(String), match: 'workspace' })
})
it.each([
  ['substring in JSON', 'index.js', JSON.stringify({ label: 'xquartzbeaconx' })],
  ['embedded prefix in minified identifier', 'index.js', '(()=>{const xsecret_value=1;return 0})()'],
  ['private asset filename', 'xquartzbeaconx.js', 'const label = "field_name"'],
  ['Unicode simple case fold', 'index.js', JSON.stringify({ label: 'ſecret_value' })],
])('rejects regression: %s', (_kind, name, content) => {
  const directory = registerTempDir(mkdtempSync(resolve(tmpdir(), 'console-scan-')))
  try {
    writeFileSync(resolve(directory, name), content)
    expect(() => scan(directory)).toThrow(/forbidden public/)
  } finally { cleanupTempDir(directory) }
})
it.each([...syntheticTerms, 'QUARTZBEACON', 'getQuartzbeacon', 'secret_value'])('public bundle scan rejects %s', content => {
  const directory = registerTempDir(mkdtempSync(resolve(tmpdir(), 'console-scan-')))
  try { writeFileSync(resolve(directory, 'index.js'), `const label = ${JSON.stringify(content)}`); expect(() => scan(directory)).toThrow('forbidden public content') }
  finally { cleanupTempDir(directory) }
})
it('public bundle scan accepts generic and malformed data URIs', () => {
  const directory = registerTempDir(mkdtempSync(resolve(tmpdir(), 'console-scan-')))
  try {
    const uri = `data:application/json;base64,${Buffer.from('{"label":"field_name"}').toString('base64')}`
    // Build the malformed URI at runtime so the SDK source scan can stay strict.
    const malformedUri = ['data:text/plain,', '%ZZ'].join('')
    writeFileSync(resolve(directory, 'index.js'), `const assets = ${JSON.stringify([uri, malformedUri])}`)
    expect(scan(directory)).toContain('0 private model IDs')
  } finally { cleanupTempDir(directory) }
})
it('public bundle scan accepts generic labels and scans nested assets', () => {
  const directory = registerTempDir(mkdtempSync(resolve(tmpdir(), 'console-scan-')))
  try { writeFileSync(resolve(directory, 'index.js'), 'const label = "field_name"'); expect(scan(directory)).toContain('0 private model IDs') }
  finally { cleanupTempDir(directory) }
})
it.each(['base64', 'percent'])('public bundle scan rejects %s data URI private content', encoding => {
  const directory = registerTempDir(mkdtempSync(resolve(tmpdir(), 'console-scan-')))
  const content = JSON.stringify({ privateMarker: syntheticTerms[0] })
  const uri = encoding === 'base64'
    ? `data:application/json;base64,${Buffer.from(content).toString('base64')}`
    : `data:application/json,${[...Buffer.from(content)].map(byte => `%${byte.toString(16).padStart(2, '0')}`).join('')}`
  try {
    writeFileSync(resolve(directory, 'index.js'), `const asset = ${JSON.stringify(uri)}`)
    expect(() => scan(directory)).toThrow('forbidden public content')
  } finally { cleanupTempDir(directory) }
})
it('allows only the exact component provenance notice', () => {
  const directory = registerTempDir(mkdtempSync(resolve(tmpdir(), 'console-scan-')))
  const notice = readFileSync(resolve(import.meta.dirname, '../packages/plugins/console/NOTICE'), 'utf8')
  try {
    writeFileSync(resolve(directory, 'index.js'), 'const label = "field_name"')
    writeFileSync(resolve(directory, 'NOTICE'), notice)
    expect(scan(directory)).toContain('0 private model IDs')
    writeFileSync(resolve(directory, 'NOTICE'), notice + `\n${syntheticTerms[0]}\n`)
    expect(() => scan(directory)).toThrow('forbidden public content')
    writeFileSync(resolve(directory, 'NOTICE'), '')
    writeFileSync(resolve(directory, 'index.js'), JSON.stringify(notice))
    expect(() => scan(directory)).toThrow('forbidden public content')
  } finally { cleanupTempDir(directory) }
})
it.each(['bundle.js.map', 'sourceMappingURL=data:application/json;base64,e30='])('rejects source map payload %s', value => {
  const directory = registerTempDir(mkdtempSync(resolve(tmpdir(), 'console-scan-')))
  try {
    writeFileSync(resolve(directory, 'index.js'), value.includes('=') ? `//# ${value}` : '')
    if (value.endsWith('.map')) writeFileSync(resolve(directory, value), '{"sources":["/private/checkout.ts"]}')
    expect(() => scan(directory)).toThrow(/source map/)
  } finally { cleanupTempDir(directory) }
})

it('skips missing private catalogs, retains present keys and rejects malformed catalogs', () => {
  const root = registerTempDir(mkdtempSync(resolve(tmpdir(), 'console-catalogs-')))
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    expect([...privateLocaleKeys(root, new Set())]).toEqual([])
    expect(log).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('skipping absent private locale input'))
    const directory = resolve(root, 'packages/frontend-console/fixtures/private/locales')
    mkdirSync(directory, { recursive: true })
    writeFileSync(resolve(directory, 'en.json'), JSON.stringify({ generic: 'Generic', privateKey: 'Private' }))
    expect([...privateLocaleKeys(root, new Set(['generic']))]).toEqual(['privateKey'])
    writeFileSync(resolve(directory, 'legacy-en.json'), JSON.stringify({ extraPrivateKey: 'Private' }))
    expect([...privateLocaleKeys(root, new Set(['generic']))]).toEqual(['privateKey', 'extraPrivateKey'])
    writeFileSync(resolve(directory, 'en.json'), '{broken')
    expect(() => privateLocaleKeys(root, new Set())).toThrow()
  } finally { log.mockRestore(); cleanupTempDir(root) }
})

it('rejects a private asset filename even when its content is clean', () => {
  const directory = registerTempDir(mkdtempSync(resolve(tmpdir(), 'console-scan-')))
  try {
    writeFileSync(resolve(directory, `${syntheticTerms[0]}.js`), 'const label = "field_name"')
    expect(() => scan(directory)).toThrow('forbidden public asset path')
  } finally { cleanupTempDir(directory) }
})

it('preserves the base behavior for decomposed Unicode and literal separators', () => {
  expect(vocabulary.test('Žlutý signál'.normalize('NFD'))).toBe(false)
  for (const content of ['secret', 'secretive', 'unrelated field_name', 'secret-value', 'secret/value', 'getSecretValue', 'cobaltGateway', 'cobalt/gateway']) expect(vocabulary.test(content), content).toBe(false)
  for (const content of ['secret_', 'QUARTZBEACON', 'xquArtzbeaconx', 'xseCret_value']) expect(vocabulary.test(content), content).toBe(true)
})

it('preserves exact legal notice, vendor filename and re-export reviews', () => {
  const root = resolve(import.meta.dirname, '..')
  const reviewed = withPolicyDataReviews(policy)
  const paths = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
  const allowedPaths = paths.filter(path => policy.nameDigests.includes(reviewDigest(path)))
  expect(allowedPaths).toHaveLength(policy.nameDigests.length)
  const pathByDigest = new Map(paths.map(path => [reviewDigest(path), path]))
  for (const path of allowedPaths) expect(() => assertBytes(path, readFileSync(resolve(root, path)), reviewed), path).not.toThrow()
  for (const review of policy.terms) {
    const path = pathByDigest.get(review.pathDigest)!
    expect(path).toBeDefined()
    const content = readFileSync(resolve(root, path))
    expect(reviewDigest(content.toString('utf8').split('\n')[review.lineNumber - 1]), path).toBe(review.lineDigest)
    expect(() => assertBytes(path, content, reviewed), path).not.toThrow()
  }
  const noticePath = 'packages/plugins/console/NOTICE'
  const notice = readFileSync(resolve(root, noticePath), 'utf8')
  expect(() => assertBytes(noticePath, Buffer.from(notice.replace('derived', 'copied')), reviewed)).toThrow('customer/owner content')
  expect(() => assertBytes('NOTICE', Buffer.from(notice), reviewed)).toThrow('customer/owner content')
})

it('checks exact Alata metadata/integrity and rejects mutations, renamed fonts and other binaries', () => {
  const directory = registerTempDir(mkdtempSync(resolve(tmpdir(), 'console-font-scan-')))
  const font = readFileSync(resolve(import.meta.dirname, '../packages/ui/src/assets/fonts/Alata-Regular.ttf'))
  try {
    mkdirSync(resolve(directory, 'assets'))
    writeFileSync(resolve(directory, 'index.js'), 'const label = "field_name"')
    const path = resolve(directory, 'assets/Alata-Regular.ttf')
    writeFileSync(path, font)
    expect(scan(directory)).toContain('0 private model IDs')
    const mutation = Buffer.from(font); mutation[mutation.length - 1] ^= 1
    writeFileSync(path, mutation)
    expect(() => scan(directory)).toThrow('integrity')
    writeFileSync(path, font)
    writeFileSync(resolve(directory, 'assets/Other.ttf'), font)
    expect(() => scan(directory)).toThrow('unreviewed binary asset')
    writeFileSync(resolve(directory, 'assets/Other.ttf'), Buffer.from([0, 1, 2, 3]))
    expect(() => scan(directory)).toThrow('unreviewed binary asset')
  } finally { cleanupTempDir(directory) }
})
