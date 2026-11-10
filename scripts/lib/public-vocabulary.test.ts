import { afterEach, expect, it, vi } from 'vitest'
import { createGuardMatcher, createTermMatcher, digestTerm, type DigestVocabulary, type Guard, type VocabularyClass } from './public-vocabulary'

// Independent old-style expressions: never derive the oracle from guardSemantics.
// All values are synthetic; /i classes intentionally contain only ASCII literals,
// exactly like their old counterparts. Separators and prefix underscores are literal.
const terms: Record<VocabularyClass, string[]> = {
  instance: ['quartzbeam', 'amber-gateway', 'amber_gateway', 'glow beam', 'éclat', 'quartz\u1f71beam', 'ſtonebeam', '\u{10428}beam'],
  consoleSubstring: ['cobaltbeam', 'azure-link', 'azure_link'],
  consolePrefix: ['silver_', 'secret_'],
  consoleWord: ['neonbeam', 'stonebeam'],
  brand: ['opalbeam', 'opalbeamcz'],
  exportSubstring: ['zincbeam'],
  mcpSubstring: ['cobaltbeam', 'neonbeam', 'marblebeam', 'opalbeam'],
}
const digest = (values: string[]): DigestVocabulary => ({ terms: values.map(value => digestTerm(value)) })
const classes: Record<VocabularyClass, DigestVocabulary> = {
  instance: digest(terms.instance),
  consoleSubstring: digest(terms.consoleSubstring),
  consolePrefix: digest(terms.consolePrefix),
  consoleWord: digest(terms.consoleWord),
  brand: digest(terms.brand),
  exportSubstring: digest(terms.exportSubstring),
  mcpSubstring: digest(terms.mcpSubstring),
}
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const alternatives = (values: string[], nfcAliases = false) => `(?:${values.map(value => nfcAliases ? escape(value).replace(/[kK]/g, '[kK]') : escape(value)).join('|')})`
function regexes(canonicalSpellings = false): Record<Guard, RegExp> {
  const literals = (values: string[]) => alternatives(values.flatMap(value => canonicalSpellings ? [value, value.normalize('NFC'), value.normalize('NFD')] : [value]), canonicalSpellings)
  const instanceSource = `(?<![\\p{L}\\p{N}_])${literals(terms.instance)}(?![\\p{L}\\p{N}_])`
  const consoleSource = `${literals([...terms.consoleSubstring, ...terms.consolePrefix])}|\\b${literals(terms.consoleWord)}\\b`
  return {
    console: new RegExp(consoleSource, 'i'),
    boundary: new RegExp(instanceSource, 'iu'),
    export: new RegExp([consoleSource, instanceSource, literals(terms.brand), literals(terms.exportSubstring)].join('|'), 'iu'),
    mcp: new RegExp(literals(terms.mcpSubstring), 'i'),
  }
}
// Kelvin is the canonical non-ASCII alias of ASCII K; long s is not an NFC alias.
const old = regexes(), nfcOracle = regexes(true)
const guards: Guard[] = ['console', 'export', 'boundary', 'mcp']
afterEach(() => vi.unstubAllEnvs())

it.each(guards)('%s has exact synthetic differential parity apart from explicit NFC tightening', guard => {
  vi.stubEnv('WORKBASE_PRIVATE_TERMS', '')
  const matcher = createGuardMatcher(guard, classes), corpus = new Set<string>(['generic field_name', ''])
  for (const term of Object.values(terms).flat()) {
    const variants = [term, term.toUpperCase(), term.normalize('NFD'),
      term.replaceAll('-', '_'), term.replaceAll('_', '-'), term.replace(/[-_ ]/g, '/'),
      term.replace(/[-_ ]/g, '  '), term.replace(/[-_ ]+(.)/g, (_, point: string) => point.toUpperCase()),
      term.replace(/s/gi, 'ſ'), term.replace(/k/gi, 'K'),
      'get' + term[0].toUpperCase() + term.slice(1), term + 'Id', term + 'Name',
      'quartz\u1fbbbeam',
    ]
    for (const variant of variants) {
      for (const before of ['', 'x', '_', '2', '-', '/', ' ', 'é', 'ſ', 'K', '\u{10428}', 'e\u0301', '\u0301', '\u0345']) {
        for (const after of ['', 'x', 'Id', 'Name', '_', '2', '-', '/', ' ', 'é', 'ſ', 'K', '\u{10428}', '\u0301', '\u0323', '\u0345']) corpus.add(before + variant + after)
      }
      corpus.add(JSON.stringify({ label: variant }))
      corpus.add(`const x${variant}Value=1`)
      corpus.add(`assets/x${variant}x.js`)
    }
  }
  let misses = 0, tightenings = 0, unexpectedRejects = 0
  for (const content of corpus) {
    const before = old[guard].test(content), after = matcher.test(content)
    if (before && !after) misses++
    if (!before && after) {
      // Deliberate tightening: NFC-equivalent spellings are scanned alike.
      // The old regex did no normalization. No other difference is permitted.
      if (nfcOracle[guard].test(content) || old[guard].test(content.normalize('NFC'))) tightenings++
      else unexpectedRejects++
    }
    if (before !== after && !(after && !before && (nfcOracle[guard].test(content) || old[guard].test(content.normalize('NFC'))))) {
      throw new Error(`${guard} differential: ${JSON.stringify(content)}; old=${before}; hashed=${after}`)
    }
  }
  expect({ misses, unexpectedRejects }).toEqual({ misses: 0, unexpectedRejects: 0 })
  console.log(`${guard} synthetic differential: checks=${corpus.size}; old-reject/new-accept=${misses}; unapproved new-reject/old-accept=${unexpectedRejects}; NFC tightenings=${tightenings}`)
})

it.each(['unicode', 'ascii', 'ascii-iu'] as const)('uses original characters for %s boundaries after NFC and folding', boundary => {
  const matcher = createTermMatcher({ terms: [digestTerm('quartzbeam', boundary)] })
  for (const content of ['quartzbeamId', 'getQuartzbeam', 'é--quartzbeamName', 'e\u0301--quartzbeamId', '\u1fbb--getQuartzbeam']) expect(matcher.test(content), content).toBe(false)
  for (const content of ['quartzbeam', 'quartzbeam\u0301', 'e\u0301--quartzbeam', '\u1fbb--quartzbeam', 'e\u0301quartzbeam']) expect(matcher.test(content), content).toBe(true)
  expect(matcher.exec('e\u0301--QUARTZBEAM')).toEqual(['QUARTZBEAM'])
  expect(matcher.test('ſquartzbeam')).toBe(boundary === 'ascii')
  expect(matcher.test('\u0345quartzbeam')).toBe(boundary !== 'unicode')
})

it('maps composition, expansion, Hangul and reordered marks back to original spans', () => {
  for (const term of ['éclat', '\u0344beam', '\uac00beam', 'q\u0323\u0307beam']) {
    const matcher = createTermMatcher({ terms: [digestTerm(term, 'unicode')] })
    const input = term.normalize('NFD')
    expect(matcher.exec('!'+input+'!')).toEqual([input])
    expect(matcher.test('x'+input+'Id')).toBe(false)
  }
  const reordered = createTermMatcher({ terms: [digestTerm('q\u0323\u0307', 'unicode')] })
  expect(reordered.test('q\u0307\u0323x')).toBe(false)
  expect(reordered.exec('!q\u0307\u0323!')).toEqual(['q\u0307\u0323'])
})

it.each(guards)('%s merges runtime terms as NFC /iu literal substrings', guard => {
  vi.stubEnv('WORKBASE_PRIVATE_TERMS', ' quartz\u1f71beam, secret_ ')
  const matcher = createGuardMatcher(guard, classes)
  for (const content of ['xquartz\u1fbbbeamx', 'xsecret_value', 'ſecret_value']) expect(matcher.test(content), content).toBe(true)
  expect(matcher.test('secretValue')).toBe(false)
})
