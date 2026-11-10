import { createHash } from 'node:crypto'

const salt = '61344a8704e93d59-dd38a3ed8094ec1c'
const folds = new Map<string, string>()
// Simple folds with expanding uppercase mappings (Unicode 17.0 CaseFolding C/S).
const simpleAlternates = new Map([['\u1fd3', '\u0390'], ['\u1fe3', '\u03b0'], ['\ufb05', '\ufb06']])
// Use the runtime's /iu equivalence for non-ASCII simple folds. Full case folding
// (which expands characters) and locale-sensitive casing are deliberately excluded.
export function foldCase(value: string): string {
  if (!/[^\x00-\x7f]/.test(value)) return value.toLowerCase()
  return value.replace(/[A-Z]|[^\x00-\x7f]/gu, character => {
    if (character.charCodeAt(0) < 128) return character.toLowerCase()
    const cached = folds.get(character)
    if (cached !== undefined) return cached
    const equivalent = new RegExp(`^${character}$`, 'iu')
    let folded = character.toLowerCase()
    if ([...folded].length !== 1 || !equivalent.test(folded)) folded = character
    const alternate = folded.toUpperCase().toLowerCase()
    if ([...alternate].length === 1 && equivalent.test(alternate)) folded = alternate
    const simple = simpleAlternates.get(folded)
    if (simple && equivalent.test(simple)) folded = simple
    folds.set(character, folded)
    return folded
  })
}
// Terms and entire inputs use the same NFC -> /iu simple-fold pipeline.
// Separators remain literal. Fingerprints select candidates; SHA-256 confirms them.
const normalize = (value: string) => foldCase(value.normalize('NFC'))
const hashTerm = (canonical: string) => createHash('sha256').update(salt + '\0' + canonical).digest('hex')
export const termDigest = (value: string) => hashTerm(normalize(value))
// Reviews hash exact bytes: changes in case, whitespace or path still need review.
export const reviewDigest = (value: string) => createHash('sha256').update(salt + '\0review\0' + value).digest('hex')

type Boundary = 'unicode' | 'ascii' | 'ascii-iu'
type CaseMode = 'i' | 'iu'
// Length, first-four fingerprint, full fingerprint, salted digest, boundary, flags.
export type DigestTerm = readonly [number, number, number, string, Boundary?, CaseMode?]
export interface DigestVocabulary { terms: readonly DigestTerm[] }
export interface TermMatcher {
  test(content: string): boolean
  exec(content: string): [string] | null
  matchesDigest(digest: string): boolean
}
const fingerprint = (value: string): number => {
  let hash = 0
  for (let index = 0; index < value.length; index++) hash = (Math.imul(hash, 31) + value.charCodeAt(index)) >>> 0
  return hash
}
export function digestTerm(value: string, boundary?: Boundary): DigestTerm {
  const normalized = normalize(value)
  if (!normalized.length) throw new Error('Empty private term')
  return [normalized.length, fingerprint(normalized.slice(0, 4)), fingerprint(normalized), hashTerm(normalized), boundary]
}

export type VocabularyClass = 'instance' | 'consoleSubstring' | 'consolePrefix' | 'consoleWord' | 'brand' | 'exportSubstring' | 'mcpSubstring'
export type Guard = 'console' | 'export' | 'boundary' | 'mcp'
interface MatchingRule {
  match: 'substring' | 'prefix' | 'word'
  boundary: Boundary | undefined
  flags: CaseMode
}
// Exact expressions at 33fef26, by consumer and vocabulary class. Prefix entries
// include their literal trailing underscore and have no leading boundary.
// ASCII console literals used /i; export rebuilt that expression with /iu.
// No old expression inserted separators or matched separate camel components.
// Deliberate tightening only: NFC aliases (including canonical Kelvin mapping)
// are scanned alike. Original boundaries and original regex coverage survive.
export const guardSemantics = {
  console: {
    instance: null,
    consoleSubstring: { match: 'substring', boundary: undefined, flags: 'i' },
    consolePrefix: { match: 'prefix', boundary: undefined, flags: 'i' },
    consoleWord: { match: 'word', boundary: 'ascii', flags: 'i' },
    brand: null,
    exportSubstring: null,
    mcpSubstring: null,
  },
  export: {
    instance: { match: 'word', boundary: 'unicode', flags: 'iu' },
    consoleSubstring: { match: 'substring', boundary: undefined, flags: 'iu' },
    consolePrefix: { match: 'prefix', boundary: undefined, flags: 'iu' },
    consoleWord: { match: 'word', boundary: 'ascii-iu', flags: 'iu' },
    brand: { match: 'substring', boundary: undefined, flags: 'iu' },
    exportSubstring: { match: 'substring', boundary: undefined, flags: 'iu' },
    mcpSubstring: null,
  },
  boundary: {
    instance: { match: 'word', boundary: 'unicode', flags: 'iu' },
    consoleSubstring: null,
    consolePrefix: null,
    consoleWord: null,
    brand: null,
    exportSubstring: null,
    mcpSubstring: null,
  },
  mcp: {
    instance: null,
    consoleSubstring: null,
    consolePrefix: null,
    consoleWord: null,
    brand: null,
    exportSubstring: null,
    mcpSubstring: { match: 'substring', boundary: undefined, flags: 'i' },
  },
} as const satisfies Record<Guard, Record<VocabularyClass, MatchingRule | null>>

// NFC can compose, expand or reorder code points. Attribute each normalized
// point's NFD atoms to original spans within its grapheme. The map is only needed
// when NFC changes the input; ASCII bundles retain the allocation-free path.
interface ScanView { text: string; nfc: string; starts?: number[]; ends?: number[] }
function originalSpans(original: string, nfc: string): { starts: number[]; ends: number[]; projection?: ScanView } | undefined {
  if (original === nfc) return undefined
  const starts: number[] = [], ends: number[] = []
  const sourcePoints: string[] = [], sourceStarts: number[] = [], sourceEnds: number[] = []
  const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' })
  for (const { segment, index } of segmenter.segment(original)) {
    const atoms: { point: string; start: number; end: number; used: boolean }[] = []
    let offset = index
    for (const point of segment) {
      const normalized = point.normalize('NFC')
      sourcePoints.push(normalized)
      for (let unit = 0; unit < normalized.length; unit++) { sourceStarts.push(offset); sourceEnds.push(offset + point.length) }
      for (const atom of point.normalize('NFD')) atoms.push({ point: atom, start: offset, end: offset + point.length, used: false })
      offset += point.length
    }
    for (const point of segment.normalize('NFC')) {
      let start = Infinity, end = 0
      for (const atom of point.normalize('NFD')) {
        const source = atoms.find(source => !source.used && source.point === atom)!
        source.used = true
        start = Math.min(start, source.start)
        end = Math.max(end, source.end)
      }
      for (let unit = 0; unit < point.length; unit++) { starts.push(start); ends.push(end) }
    }
  }
  // Preserve original cut positions consumed by cross-point composition. E.g.
  // a literal base letter followed by a combining mark was an old regex match.
  // These candidates are derived while building the map, before any matching;
  // every source point still receives NFC and the same simple fold. There is no
  // raw, unnormalized fallback and no invented boundary character.
  const sourceNfc = sourcePoints.join('')
  const projection = sourceNfc === nfc ? undefined : { text: foldCase(sourceNfc), nfc: sourceNfc, starts: sourceStarts, ends: sourceEnds }
  return { starts, ends, projection }
}
const unicodeWord = /[\p{L}\p{N}_]/iu, asciiWord = /\w/, asciiUnicodeWord = /\w/iu
const beforePoint = (text: string, index: number) => {
  const last = text.charCodeAt(index - 1)
  return index >= 2 && last >= 0xdc00 && last <= 0xdfff ? text.slice(index - 2, index) : text.slice(index - 1, index)
}

export function createTermMatcher(vocabulary: DigestVocabulary): TermMatcher {
  // Optional private-pipeline additions are literal NFC /iu substrings in every
  // guard; they never replace or inherit boundaries from the offline vocabulary.
  const additions = (process.env.WORKBASE_PRIVATE_TERMS ?? '').split(',').map(value => value.trim()).filter(Boolean).map(value => digestTerm(value))
  const entries = [...vocabulary.terms, ...additions]
  const digests = new Set(entries.map(entry => entry[3]))
  const groups = new Map<number, Map<number, DigestTerm[]>>()
  for (const entry of entries) {
    const width = Math.min(4, entry[0])
    if (!groups.has(width)) groups.set(width, new Map())
    const buckets = groups.get(width)!
    if (!buckets.has(entry[1])) buckets.set(entry[1], [])
    if (!buckets.get(entry[1])!.some(other => other[3] === entry[3] && other[4] === entry[4] && other[5] === entry[5])) buckets.get(entry[1])!.push(entry)
  }
  const filters = [...groups].map(([width, buckets]) => {
    const filter = new Uint8Array(65536)
    for (const head of buckets.keys()) filter[head & 65535] = 1
    return { width, buckets, filter, power: 31 ** (width - 1) }
  })
  const exec = (original: string): [string] | null => {
    const nfc = original.normalize('NFC'), text = foldCase(nfc)
    const spans = originalSpans(original, nfc)
    const scan = ({ text, nfc, starts, ends }: ScanView): [string] | null => {
      for (const { width, buckets, filter, power } of filters) {
        if (text.length < width) continue
        let head = 0
        for (let index = 0; index < width; index++) head = (Math.imul(head, 31) + text.charCodeAt(index)) >>> 0
        for (let start = 0; start <= text.length - width; start++) {
          if (filter[head & 65535]) for (const [length, , full, digest, boundary, flags] of buckets.get(head) ?? []) {
            const end = start + length
            if (end > text.length) continue
            let from = start, to = end
            if (starts && ends) {
              from = Infinity; to = 0
              // Canonical reordering can put the last source atom in the middle
              // of a candidate. Its original span must include every atom.
              for (let index = start; index < end; index++) { from = Math.min(from, starts[index]); to = Math.max(to, ends[index]) }
            }
            if (boundary) {
              const word = boundary === 'unicode' ? unicodeWord : boundary === 'ascii-iu' ? asciiUnicodeWord : asciiWord
              const before = from ? beforePoint(original, from) : ''
              const after = to < original.length ? String.fromCodePoint(original.codePointAt(to)!) : ''
              if (word.test(before) || word.test(after)) continue
            }
            // The legacy /i classes contain only ASCII literals. /iu additionally
            // folds non-ASCII points to ASCII; /i must not gain those equivalents.
            // Inspect NFC text here so the documented NFC tightening is uniform.
            if (flags === 'i' && /[^\x00-\x7f]/.test(nfc.slice(start, end))) continue
            let hash = head
            for (let index = start + width; index < end; index++) hash = (Math.imul(hash, 31) + text.charCodeAt(index)) >>> 0
            if (hash === full && hashTerm(text.slice(start, end)) === digest) return [original.slice(from, to)]
          }
          head = (Math.imul(head - Math.imul(text.charCodeAt(start), power), 31) + text.charCodeAt(start + width)) >>> 0
        }
      }
      return null
    }
    return scan({ text, nfc, starts: spans?.starts, ends: spans?.ends }) ?? (spans?.projection ? scan(spans.projection) : null)
  }
  return { exec, test: content => exec(content) !== null, matchesDigest: digest => digests.has(digest) }
}

export function mergeVocabularies(...vocabularies: DigestVocabulary[]): DigestVocabulary {
  return { terms: vocabularies.flatMap(vocabulary => [...vocabulary.terms]) }
}

function guardVocabulary(guard: Guard, classes: Record<VocabularyClass, DigestVocabulary>): DigestVocabulary {
  const terms: DigestTerm[] = []
  for (const name of Object.keys(guardSemantics[guard]) as VocabularyClass[]) {
    const rule = guardSemantics[guard][name]
    if (rule) for (const entry of classes[name].terms) terms.push([entry[0], entry[1], entry[2], entry[3], rule.boundary, rule.flags])
  }
  return { terms }
}
export function createGuardMatcher(guard: Guard, classes: Record<VocabularyClass, DigestVocabulary> = vocabularyClasses): TermMatcher {
  return createTermMatcher(guardVocabulary(guard, classes))
}

const vocabularyClasses: Record<VocabularyClass, DigestVocabulary> = {
  instance: { terms: [
    [6, 3560079, 3421239626, '55730410634816ee2657b991a5f410a9cbef4d02ea15d26eee548e4c1d23ccd4'],
    [10, 3237038, 3950661280, 'd6a0a3bf674c4dd754860ffb6bb4013b754460e1cea077f7ac83fb4b2a002cd8'],
    [13, 3059506, 1357041679, '9a86c1ae061f93eb7a912618d7ad7abccad845a9d5ba97749c5709401067db70'],
    [8, 3056325, 790188281, '02c71eed543467e720c52f6654abf80b28449badbd924271e0a1b71d001c34ce'],
    [7, 3079687, 1552746787, '6e179c16eed56a08f4ff412e1377fb7e15522eb1eade03e61d61b94fd2fd38b6'],
    [16, 3526678, 1662965724, '36fc73bb15f6390ed78adefbfd2b76c97ca2fe8cadbfcc37a96544e0715446a0'],
    [16, 3526678, 1484555790, '6e9a64cfecd11badcb33a8afa141d7dd422ca46d489d334e8ffa4bf732c03c39'],
    [15, 3526678, 772776313, '606a28c95c29770454fe770d1bde310d770bde41753ae90349c953a02b5d487e'],
    [7, 3542039, 2441769461, 'dc5be7cde6e7990a77cff7582b36723484a51f6c3bced25f56fea61d9a75014d'],
    [7, 3522382, 1856174091, '6a935b21e75904132f361d5472da879a2fb6e20ff734f4606fe582ad89b3c7af'],
    [7, 3236384, 1925931975, '4b77db8d2431d5568aed78f7299e66619a09688da7f3fb7431294b03dae7fd9f'],
    [5, 3541177, 109776599, 'f18d988004f9658edffd4390742a826ef4e748c769d17cb70ed658a1e140e2d9'],
    [10, 3313778, 1365921939, 'ca450d342c39aca6cb27ea1be3bbe619a3e4789852f175eb6c8134bc2fcadbf9'],
    [8, 3419560, 1237881597, '8a4791ef4cd28d05ec95a9dc0158d8ca5b6c642b9151e466ab2080160f6290ba'],
    [6, 3526234, 3388718194, '398abaa082330ad7de4266bd3ea01cfad7a705bde6cd9d968564663d77628b14'],
    [5, 3433286, 106431974, '6453a8714591438a56d59320a72062e1946a2bcd12583ab1d2ea5254fba13e63'],
    [9, 3236384, 3984697786, '331b4edcda3d842029de2c5cb3d9ea23e3752de6ccb10daaa9498d7e7fc69f30'],
    [9, 3728819, 1728532632, 'a784ce7e9b751190eaf58b001393d388e2801e026b36ecf89c1e509c5e68bf86'],
    [6, 3088956, 2968490271, 'ab6dc44c73dc5b149c390b7805e5cf63848f15e7955eb8a86413e67012adbb90'],
    [9, 3496405, 705896143, 'c79321e4ca3a88a7a471fc983f728f713feb87a7f8b422c1b73b289b7d13cbc9'],
    [10, 3555990, 2609826148, '0af1c10c52b0d13a7bcb79a1b5f0e9ae91ab2967f57a876fa28e913429efb1e4'],
    [12, 3542039, 1339630549, 'd4a4112ce4b2139228200168b1fb891ab9e665880c40b8e4dfa85886948233c1'],
    [5, 3444755, 106787750, '5ab92a1db1816d4940defc690545d1b6aa9f2af1a12bf70e7a4684c9fdab7b79'],
    [7, 3496405, 1082297053, 'e793b162eda02db9456d9925e37c141f6e61ae86762004200827c84d100d550a'],
    [7, 3555990, 2857392058, '59fc3f2b25727d51f915fbbedc3ba0c176bbbab3e23f35750410d1a7a2dda46b'],
    [10, 3437282, 4089893505, '1e6f98c1134fb2abc44f88a1644fd11a75c6338b882987b188456e6ae0f92e74'],
    [11, 3437282, 2845531347, 'd94cb86bf0b817bb9ce9ec0ee3bb6be45df480a8471fdafd3023dd6dcbf87753'],
  ] },
  consoleSubstring: { terms: [
    [6, 3560079, 3421239626, '55730410634816ee2657b991a5f410a9cbef4d02ea15d26eee548e4c1d23ccd4'],
    [10, 3237038, 3950661280, 'd6a0a3bf674c4dd754860ffb6bb4013b754460e1cea077f7ac83fb4b2a002cd8'],
    [8, 3056325, 790188281, '02c71eed543467e720c52f6654abf80b28449badbd924271e0a1b71d001c34ce'],
    [16, 3526678, 1662965724, '36fc73bb15f6390ed78adefbfd2b76c97ca2fe8cadbfcc37a96544e0715446a0'],
    [16, 3526678, 1484555790, '6e9a64cfecd11badcb33a8afa141d7dd422ca46d489d334e8ffa4bf732c03c39'],
  ] },
  consolePrefix: { terms: [
    [8, 3327947, 2530657497, '0db0939df687e5a3dba387c259047ba31e75df883e54e7b6bda3acc36ead81c7'],
    [6, 3565984, 3426913943, 'c7ba58681b4cc01a5018523897d74ff8211e421a86b739cf943d579f8cdc2829'],
    [8, 3542039, 2680409354, '81b0814d0e706f6d699e451f2fd25f1bb3c55b84cf2b196ea22e5039cfae5f10'],
    [8, 3433510, 1235842554, 'b1ff03efebc21f12582a51bd3ce6e5573ae76c2be36d948ba5c6308d99a968bc'],
  ] },
  consoleWord: { terms: [
    [13, 3059506, 1357041679, '9a86c1ae061f93eb7a912618d7ad7abccad845a9d5ba97749c5709401067db70'],
    [8, 3296584, 3631448348, '9a88b87373386022c4156450a0d91fef7f5f2f758687a8ca0540b0e4ce02afbb'],
    [4, 3419498, 3419498, '0f778e3b0028ce22d3aea77893a4fd329087023569479ade262523cb1a28acce'],
    [8, 3555933, 2627405331, '33fa871c93771fc7ad0954be02f180facbf19d8f338f3495cc70d3f3e006cbe2'],
  ] },
  brand: { terms: [
    [6, 3560079, 3421239626, '55730410634816ee2657b991a5f410a9cbef4d02ea15d26eee548e4c1d23ccd4'],
    [8, 3560079, 2161302337, '5f713191b76deef51141247f735d00c6581774aecefe323d847dfca7d7b929d5'],
  ] },
  exportSubstring: { terms: [
    [12, 3541168, 2025353193, '2c2f21625ddb18a305964a68241bf195642d74b31c57fab1c82b1a4969f87cdf'],
  ] },
  mcpSubstring: { terms: [
    [8, 3296584, 3631448348, '9a88b87373386022c4156450a0d91fef7f5f2f758687a8ca0540b0e4ce02afbb'],
    [13, 3059506, 1357041679, '9a86c1ae061f93eb7a912618d7ad7abccad845a9d5ba97749c5709401067db70'],
    [6, 3560079, 3421239626, '55730410634816ee2657b991a5f410a9cbef4d02ea15d26eee548e4c1d23ccd4'],
    [10, 3237038, 3950661280, 'd6a0a3bf674c4dd754860ffb6bb4013b754460e1cea077f7ac83fb4b2a002cd8'],
  ] },
}

export const instanceVocabulary = guardVocabulary('boundary', vocabularyClasses)
export const consoleVocabulary = guardVocabulary('console', vocabularyClasses)
export const brandVocabulary = vocabularyClasses.brand
export const exportVocabulary = vocabularyClasses.exportSubstring

export const instanceNames = createGuardMatcher('boundary')
export const consolePrivateTerms = createGuardMatcher('console')
export const privateBrand = createTermMatcher(brandVocabulary)
export const customerTerms = createGuardMatcher('export')
export const mcpTerms = createGuardMatcher('mcp')
