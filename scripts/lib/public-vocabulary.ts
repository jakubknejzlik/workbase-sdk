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
// Digest terms use NFC, simple case folding and a canonical separator.
const normalize = (value: string) => foldCase(value.normalize('NFC')).replace(/[-_/\s]+/g, '_')
export const termDigest = (value: string) => createHash('sha256').update(salt + '\0' + normalize(value)).digest('hex')
// Reviews hash exact bytes: changes in case, whitespace or path still need review.
export const reviewDigest = (value: string) => createHash('sha256').update(salt + '\0review\0' + value).digest('hex')

type Boundary = 'unicode' | 'ascii'
// Length, first-four fingerprint, full fingerprint, salted digest, boundary rule.
// Fingerprints only select candidates; SHA-256 always confirms a match.
export type DigestTerm = readonly [number, number, number, string, Boundary?]
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
  return [normalized.length, fingerprint(normalized.slice(0, 4)), fingerprint(normalized), termDigest(value), boundary]
}

export function createTermMatcher(vocabulary: DigestVocabulary): TermMatcher {
  // Optional private-pipeline additions never replace the offline vocabulary.
  const additions = (process.env.WORKBASE_PRIVATE_TERMS ?? '').split(',').map(value => value.trim()).filter(Boolean).map(value => digestTerm(value))
  const entries = [...vocabulary.terms, ...additions]
  const digests = new Set(entries.map(entry => entry[3]))
  const groups = new Map<number, Map<number, DigestTerm[]>>()
  for (const entry of entries) {
    const width = Math.min(4, entry[0])
    if (!groups.has(width)) groups.set(width, new Map())
    const buckets = groups.get(width)!
    if (!buckets.has(entry[1])) buckets.set(entry[1], [])
    if (!buckets.get(entry[1])!.some(other => other[3] === entry[3] && other[4] === entry[4])) buckets.get(entry[1])!.push(entry)
  }
  const filters = [...groups].map(([width, buckets]) => {
    const filter = new Uint8Array(65536)
    for (const head of buckets.keys()) filter[head & 65535] = 1
    return { width, buckets, filter, power: 31 ** (width - 1) }
  })
  const bounded = (text: string, start: number, end: number, boundary?: Boundary): boolean => {
    if (!boundary) return true
    const word = boundary === 'unicode' ? /[\p{L}\p{N}_]/iu : /\w/
    const before = [...text.slice(Math.max(0, start - 2), start)].at(-1) ?? ''
    const after = String.fromCodePoint(text.codePointAt(end) ?? 0)
    return !word.test(before) && !word.test(after)
  }
  const scan = (text: string, original = text): [string] | null => {
    // A hyphen and underscore hash identically, but have different boundaries.
    const code = (index: number) => {
      const value = text.charCodeAt(index)
      return value === 45 || value === 47 || value === 32 || value >= 9 && value <= 13 ? 95 : value
    }
    for (const { width, buckets, filter, power } of filters) {
      if (text.length < width) continue
      let head = 0
      for (let index = 0; index < width; index++) head = (Math.imul(head, 31) + code(index)) >>> 0
      for (let start = 0; start <= text.length - width; start++) {
        if (filter[head & 65535]) for (const [length, , full, digest, boundary] of buckets.get(head) ?? []) {
          const end = start + length
          if (end > text.length || !bounded(original, start, end, boundary)) continue
          let hash = head
          for (let index = start + width; index < end; index++) hash = (Math.imul(hash, 31) + code(index)) >>> 0
          if (hash === full) {
            const candidate = text.slice(start, end)
            if (termDigest(candidate) === digest) return [candidate]
          }
        }
        head = (Math.imul(head - Math.imul(code(start), power), 31) + code(start + width)) >>> 0
      }
    }
    return null
  }
  const exec = (content: string): [string] | null => {
    // Keep non-word separators distinct from literal underscores for boundaries.
    const separated = (value: string) => foldCase(value).replace(/[-/\s]+/g, '-').replace(/_+/g, '_')
    const exact = scan(foldCase(content), content)
    if (exact) return exact
    // Scan intact text first: splitting mixed-case words must never hide a match.
    // Camel components remain eligible, as in the original hashed guard.
    const components = content.normalize('NFC').replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1-$2')
      .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1-$2')
    const normalized = separated(components)
    return normalized === content ? null : scan(normalized)
  }
  return { exec, test: content => exec(content) !== null, matchesDigest: digest => digests.has(digest) }
}

export function mergeVocabularies(...vocabularies: DigestVocabulary[]): DigestVocabulary {
  return { terms: vocabularies.flatMap(vocabulary => [...vocabulary.terms]) }
}

export const instanceVocabulary: DigestVocabulary = {
  terms: [
    [6, 3560079, 3421239626, '55730410634816ee2657b991a5f410a9cbef4d02ea15d26eee548e4c1d23ccd4', 'unicode'],
    [10, 3237038, 3950661280, 'd6a0a3bf674c4dd754860ffb6bb4013b754460e1cea077f7ac83fb4b2a002cd8', 'unicode'],
    [13, 3059506, 1357041679, '9a86c1ae061f93eb7a912618d7ad7abccad845a9d5ba97749c5709401067db70', 'unicode'],
    [8, 3056325, 790188281, '02c71eed543467e720c52f6654abf80b28449badbd924271e0a1b71d001c34ce', 'unicode'],
    [7, 3079687, 1552746787, '6e179c16eed56a08f4ff412e1377fb7e15522eb1eade03e61d61b94fd2fd38b6', 'unicode'],
    [16, 3526678, 1484555790, '6e9a64cfecd11badcb33a8afa141d7dd422ca46d489d334e8ffa4bf732c03c39', 'unicode'],
    [15, 3526678, 772776313, '606a28c95c29770454fe770d1bde310d770bde41753ae90349c953a02b5d487e', 'unicode'],
    [7, 3542039, 2441769461, 'dc5be7cde6e7990a77cff7582b36723484a51f6c3bced25f56fea61d9a75014d', 'unicode'],
    [7, 3522382, 1856174091, '6a935b21e75904132f361d5472da879a2fb6e20ff734f4606fe582ad89b3c7af', 'unicode'],
    [7, 3236384, 1925931975, '4b77db8d2431d5568aed78f7299e66619a09688da7f3fb7431294b03dae7fd9f', 'unicode'],
    [5, 3541177, 109776599, 'f18d988004f9658edffd4390742a826ef4e748c769d17cb70ed658a1e140e2d9', 'unicode'],
    [10, 3313778, 1365921939, 'ca450d342c39aca6cb27ea1be3bbe619a3e4789852f175eb6c8134bc2fcadbf9', 'unicode'],
    [8, 3419560, 1237881597, '8a4791ef4cd28d05ec95a9dc0158d8ca5b6c642b9151e466ab2080160f6290ba', 'unicode'],
    [6, 3526234, 3388718194, '398abaa082330ad7de4266bd3ea01cfad7a705bde6cd9d968564663d77628b14', 'unicode'],
    [5, 3433286, 106431974, '6453a8714591438a56d59320a72062e1946a2bcd12583ab1d2ea5254fba13e63', 'unicode'],
    [9, 3236384, 3984697786, '331b4edcda3d842029de2c5cb3d9ea23e3752de6ccb10daaa9498d7e7fc69f30', 'unicode'],
    [9, 3730772, 1806689687, 'dc4d7d42b3b70be61074e73838f32c44633e224d58b701e6c07b6a662cde9edb', 'unicode'],
    [6, 3088956, 2968490271, 'ab6dc44c73dc5b149c390b7805e5cf63848f15e7955eb8a86413e67012adbb90', 'unicode'],
    [9, 3496405, 705896143, 'c79321e4ca3a88a7a471fc983f728f713feb87a7f8b422c1b73b289b7d13cbc9', 'unicode'],
    [10, 3555990, 2609826148, '0af1c10c52b0d13a7bcb79a1b5f0e9ae91ab2967f57a876fa28e913429efb1e4', 'unicode'],
    [12, 3542039, 1339630549, 'd4a4112ce4b2139228200168b1fb891ab9e665880c40b8e4dfa85886948233c1', 'unicode'],
    [5, 3444755, 106787750, '5ab92a1db1816d4940defc690545d1b6aa9f2af1a12bf70e7a4684c9fdab7b79', 'unicode'],
    [7, 3496405, 1082297053, 'e793b162eda02db9456d9925e37c141f6e61ae86762004200827c84d100d550a', 'unicode'],
    [7, 3555990, 2857392058, '59fc3f2b25727d51f915fbbedc3ba0c176bbbab3e23f35750410d1a7a2dda46b', 'unicode'],
    [10, 3437282, 4089893505, '1e6f98c1134fb2abc44f88a1644fd11a75c6338b882987b188456e6ae0f92e74', 'unicode'],
    [11, 3437282, 2845531347, 'd94cb86bf0b817bb9ce9ec0ee3bb6be45df480a8471fdafd3023dd6dcbf87753', 'unicode']
  ]
}

export const consoleVocabulary: DigestVocabulary = {
  terms: [
    [6, 3560079, 3421239626, '55730410634816ee2657b991a5f410a9cbef4d02ea15d26eee548e4c1d23ccd4'],
    [10, 3237038, 3950661280, 'd6a0a3bf674c4dd754860ffb6bb4013b754460e1cea077f7ac83fb4b2a002cd8'],
    [8, 3056325, 790188281, '02c71eed543467e720c52f6654abf80b28449badbd924271e0a1b71d001c34ce'],
    [16, 3526678, 1484555790, '6e9a64cfecd11badcb33a8afa141d7dd422ca46d489d334e8ffa4bf732c03c39'],
    [8, 3327947, 2530657497, '0db0939df687e5a3dba387c259047ba31e75df883e54e7b6bda3acc36ead81c7'],
    [6, 3565984, 3426913943, 'c7ba58681b4cc01a5018523897d74ff8211e421a86b739cf943d579f8cdc2829'],
    [8, 3542039, 2680409354, '81b0814d0e706f6d699e451f2fd25f1bb3c55b84cf2b196ea22e5039cfae5f10'],
    [8, 3433510, 1235842554, 'b1ff03efebc21f12582a51bd3ce6e5573ae76c2be36d948ba5c6308d99a968bc'],
    [13, 3059506, 1357041679, '9a86c1ae061f93eb7a912618d7ad7abccad845a9d5ba97749c5709401067db70', 'ascii'],
    [8, 3296584, 3631448348, '9a88b87373386022c4156450a0d91fef7f5f2f758687a8ca0540b0e4ce02afbb', 'ascii'],
    [4, 3419498, 3419498, '0f778e3b0028ce22d3aea77893a4fd329087023569479ade262523cb1a28acce', 'ascii'],
    [8, 3555933, 2627405331, '33fa871c93771fc7ad0954be02f180facbf19d8f338f3495cc70d3f3e006cbe2', 'ascii']
  ]
}

export const brandVocabulary: DigestVocabulary = {
  terms: [
    [6, 3560079, 3421239626, '55730410634816ee2657b991a5f410a9cbef4d02ea15d26eee548e4c1d23ccd4'],
    [8, 3560079, 2161302337, '5f713191b76deef51141247f735d00c6581774aecefe323d847dfca7d7b929d5']
  ]
}

export const exportVocabulary: DigestVocabulary = {
  terms: [
    [12, 3541168, 2025353193, '2c2f21625ddb18a305964a68241bf195642d74b31c57fab1c82b1a4969f87cdf']
  ]
}

export const instanceNames = createTermMatcher(instanceVocabulary)
export const consolePrivateTerms = createTermMatcher(consoleVocabulary)
export const privateBrand = createTermMatcher(brandVocabulary)
export const customerTerms = createTermMatcher(mergeVocabularies(instanceVocabulary, consoleVocabulary, brandVocabulary, exportVocabulary))
