import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { buildGuardRegexes } from './public-vocabulary'
import { loadPrivateTerms, termDigest } from './private-terms'

// Synthetic replacement of the base's 36 literals. The oracle below retains the
// base expressions independently of the production builder and digest manifest.
const terms = [
  'quartz01beam', 'quartz02beam', 'quartz03beam', 'quartz04beam', 'éclat',
  'silver-bridge', 'silver_bridge', 'silverbridge', 'quartz09beam', 'quartz10beam',
  'quartz11beam', 'quartz12beam', 'quartz13beam', 'quartz14beam', 'quartz15beam',
  'quartz16beam', 'quartz17beam', 'glow beam', 'quartz19beam', 'quartz20beam',
  'quartz21beam', 'quartz22beam', 'quartz23beam', 'quartz24beam', 'quartz25beam',
  'quartz26beam', 'quartz27beam', 'cloud_', 'secret_', 'river_', 'neon_',
  'stonebeam', 'amberbeam', 'opalbeam', 'quartz01beamcz', 'zincbeam',
]
function baseRegexes() {
  const escapedTerms = terms.slice(0, 27).map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const instanceNames = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${escapedTerms.join('|')})(?![\\p{L}\\p{N}_])`, 'iu')
  const consolePrivateTerms = /quartz01beam|quartz02beam|quartz04beam|silver[-_]bridge|cloud_|secret_|river_|neon_|\b(?:quartz03beam|stonebeam|amberbeam|opalbeam)\b/i
  const privateBrand = /quartz01beam(?:cz)?/iu
  const customerTerms = new RegExp([consolePrivateTerms.source, instanceNames.source, privateBrand.source, 'zincbeam'].join('|'), 'iu')
  const mcpTerms = /workspace:|file:|overrides|tarball|public-console|BOOTSTRAP GAP|stonebeam|quartz03beam|quartz01beam|quartz02beam|packages\/core\/src/i
  return { instanceNames, consolePrivateTerms, privateBrand, customerTerms, mcpTerms }
}
const before = baseRegexes()
const after = buildGuardRegexes(terms)
afterEach(() => vi.unstubAllEnvs())

it.each(Object.keys(before) as (keyof typeof before)[])('%s has identical base regex source, flags and corpus results', guard => {
  expect(after[guard].source).toBe(before[guard].source)
  expect(after[guard].flags).toBe(before[guard].flags)
  const corpus = new Set(['', 'generic field_name', 'fieldName member_id', 'workspace:', 'packages/core/src'])
  const contexts = ['', 'a', '_', '2', '-', '/', ' ', 'é', 'ſ', 'K', '\u{10428}', 'e\u0301', '\u0301', '\u0345', 'a\udc00', 'é\udfff', '_\udc01', '2\udc00', 'a\ud800\udc00', '\udc00', 'a\ud800']
  for (const term of terms) {
    for (const variant of [term, term.toUpperCase(), term.normalize('NFD'), term.replaceAll('-', '_'), term.replaceAll('_', '-'), term.replace(/[-_ ]/g, '/'), term.replace(/[-_ ]+(.)/g, (_, point: string) => point.toUpperCase()), term.replace(/s/gi, 'ſ'), term.replace(/k/gi, 'K'), 'get' + term, term + 'Id', term + 'Name']) {
      for (const left of contexts) for (const right of contexts) corpus.add(left + variant + right)
      corpus.add(JSON.stringify({ label: variant }))
      corpus.add(`assets/x${variant}x.js`)
    }
  }
  for (const input of corpus) {
    expect(after[guard].test(input), `${guard}: ${JSON.stringify(input)}`).toBe(before[guard].test(input))
  }
  console.log(`${guard}: source+flags identical; corpus=${corpus.size}; differences=0`)
})

it('enforces extra terms literally in every guard without normalizing scanned content', () => {
  const guards = buildGuardRegexes([...terms, 'cobalt.beam', 'Žlutý signál'])
  for (const regex of Object.values(guards)) {
    expect(regex.test('xCOBALT.BEAMx')).toBe(true)
    expect(regex.test('cobaltXbeam')).toBe(false)
    expect(regex.test('Žlutý signál')).toBe(true)
    expect(regex.test('Žlutý signál'.normalize('NFD'))).toBe(false)
  }
})

const requiredTerms = ['quartzbeam', 'éclat', 'secret_']
const exactDigest = (term: string) => createHash('sha256').update('61344a8704e93d59-dd38a3ed8094ec1c' + '\0' + term).digest('hex')
const required = requiredTerms.map(exactDigest)
const message = 'private terms not provided / incomplete; set WORKBASE_PRIVATE_TERMS'
it('fails closed when the production guard module is started without either env input', () => {
  const env = { ...process.env }
  delete env.WORKBASE_PRIVATE_TERMS
  delete env.WORKBASE_PRIVATE_TERMS_FILE
  const result = spawnSync('bun', [join(import.meta.dirname, 'public-vocabulary.ts')], { env, encoding: 'utf8' })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(message)
})
it.each([{}, { WORKBASE_PRIVATE_TERMS: '' }, { WORKBASE_PRIVATE_TERMS: 'quartzbeam\nsecret_' }, { WORKBASE_PRIVATE_TERMS: 'quartzbeam\neclat\nsecret_' }, { WORKBASE_PRIVATE_TERMS: requiredTerms.join(',') }, { WORKBASE_PRIVATE_TERMS_FILE: '/does-not-exist/private-terms.txt' }])('fails closed for missing or incomplete terms: %#', env => {
  expect(() => loadPrivateTerms(env, required)).toThrow(message)
})
it('accepts complete newline input, CRLF and extra terms, preserving literal spellings', () => {
  const supplied = [...requiredTerms, 'extra.beam']
  expect(loadPrivateTerms({ WORKBASE_PRIVATE_TERMS: supplied.join('\r\n') + '\n' }, required)).toEqual(supplied)
})
const changedSpellings = [
  { variant: 'ASCII case', slot: 0, value: 'QUARTZBEAM' },
  { variant: 'NFD', slot: 1, value: requiredTerms[1].normalize('NFD') },
  { variant: 'Unicode simple fold', slot: 2, value: 'ſecret_' },
]
it.each((['env', 'file'] as const).flatMap(input => changedSpellings.map(change => ({ input, ...change }))))('rejects $variant required spelling from $input input', ({ input, slot, value }) => {
  const directory = mkdtempSync(join(tmpdir(), 'private-terms-test-'))
  const path = join(directory, 'terms.txt')
  try {
    const supplied = [...requiredTerms]
    supplied[slot] = value
    const text = supplied.join('\n')
    writeFileSync(path, text, { mode: 0o600 })
    const env = input === 'env' ? { WORKBASE_PRIVATE_TERMS: text } : { WORKBASE_PRIVATE_TERMS_FILE: path }
    expect(() => loadPrivateTerms(env, required)).toThrow(message)
  } finally { rmSync(directory, { recursive: true }) }
})
it('hashes exact UTF-8 spellings without canonicalization', () => {
  for (const term of [...requiredTerms, ...changedSpellings.map(change => change.value), ' padded ']) {
    expect(termDigest(term)).toBe(exactDigest(term))
  }
})
it('fails closed when the complete manifest is reordered', () => {
  expect(() => loadPrivateTerms({ WORKBASE_PRIVATE_TERMS: [...requiredTerms].reverse().join('\n') }, required)).toThrow('preserve term #N order')
})
it('reads an explicit file and gives a nonempty inline env value priority', () => {
  const directory = mkdtempSync(join(tmpdir(), 'private-terms-test-'))
  const path = join(directory, 'terms.txt')
  try {
    writeFileSync(path, requiredTerms.join('\n'), { mode: 0o600 })
    expect(loadPrivateTerms({ WORKBASE_PRIVATE_TERMS_FILE: path }, required)).toEqual(requiredTerms)
    expect(() => loadPrivateTerms({ WORKBASE_PRIVATE_TERMS: 'incomplete', WORKBASE_PRIVATE_TERMS_FILE: path }, required)).toThrow(message)
  } finally { rmSync(directory, { recursive: true }) }
})
