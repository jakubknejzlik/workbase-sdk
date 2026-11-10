import { createHash } from 'node:crypto'

const salt = '61344a8704e93d59-dd38a3ed8094ec1c'
// Terms use NFC and lowercase; runs of whitespace, -, _ and / become _.
// Candidate words also split camelCase; trailing separators retain prefix matching.
const normalize = (value: string) => value.normalize('NFC').toLowerCase().replace(/[-_/\s]+/g, '_')
export const termDigest = (value: string) => createHash('sha256').update(salt + '\0' + normalize(value)).digest('hex')
// Reviews hash exact bytes: changes in case, whitespace or path still need review.
export const reviewDigest = (value: string) => createHash('sha256').update(salt + '\0review\0' + value).digest('hex')

export interface DigestVocabulary {
  terms: readonly string[]
  prefixes?: readonly (readonly [number, string])[]
  maxWords?: number
}
export interface TermMatcher {
  test(content: string): boolean
  exec(content: string): [string] | null
  matchesDigest(digest: string): boolean
}

export function createTermMatcher(vocabulary: DigestVocabulary): TermMatcher {
  const terms = new Set(vocabulary.terms)
  const prefixes = new Map<number, Set<string>>()
  const addPrefix = (length: number, digest: string) => {
    if (!prefixes.has(length)) prefixes.set(length, new Set())
    prefixes.get(length)!.add(digest)
  }
  for (const [length, digest] of vocabulary.prefixes ?? []) addPrefix(length, digest)
  let maxWords = vocabulary.maxWords ?? 2
  // Optional private-pipeline additions never replace the offline vocabulary.
  for (const value of (process.env.WORKBASE_PRIVATE_TERMS ?? '').split(',').map(value => value.trim()).filter(Boolean)) {
    const normalized = normalize(value)
    if (normalized.endsWith('_')) addPrefix(normalized.length, termDigest(value))
    else terms.add(termDigest(value))
    maxWords = Math.max(maxWords, normalized.split('_').length)
  }
  const matchesDigest = (digest: string) => terms.has(digest)
  const cache = new Map<string, boolean>()
  const matches = (candidate: string): boolean => {
    const normalized = normalize(candidate)
    const cached = cache.get(normalized)
    if (cached !== undefined) return cached
    const result = matchesDigest(termDigest(normalized)) || [...prefixes].some(([length, digests]) =>
      normalized.length >= length && digests.has(termDigest(normalized.slice(0, length))))
    if (cache.size >= 50000) cache.clear()
    cache.set(normalized, result)
    return result
  }
  const exec = (content: string): [string] | null => {
    const text = content.normalize('NFC')
    let previousEnd = 0
    let words: string[] = []
    for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
      const word = match[0], start = match.index, end = start + word.length
      if (!/^[-_/\s]+$/.test(text.slice(previousEnd, start))) words = []
      // Keep the unsplit identifier as well as its component words.
      const trailing = /^[-_/]/.test(text.slice(end, end + 1)) ? '_' : ''
      if (matches(word + trailing) || matches(word)) return [word]
      const parts = word.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1_$2')
        .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1_$2').split('_')
      for (const [index, part] of parts.entries()) {
        words.push(part)
        if (words.length > maxWords) words.shift()
        for (let count = 1; count <= words.length; count++) {
          const candidate = words.slice(-count).join('_')
          if (matches(candidate) || (index < parts.length - 1 || trailing) && matches(candidate + '_')) return [candidate]
        }
      }
      previousEnd = end
    }
    return null
  }
  return { exec, test: content => exec(content) !== null, matchesDigest }
}

export function mergeVocabularies(...vocabularies: DigestVocabulary[]): DigestVocabulary {
  return {
    terms: vocabularies.flatMap(vocabulary => [...vocabulary.terms]),
    prefixes: vocabularies.flatMap(vocabulary => [...vocabulary.prefixes ?? []]),
    maxWords: Math.max(2, ...vocabularies.map(vocabulary => vocabulary.maxWords ?? 2)),
  }
}

export const instanceVocabulary: DigestVocabulary = {
  terms: [
    '6e9a64cfecd11badcb33a8afa141d7dd422ca46d489d334e8ffa4bf732c03c39',
    '9a86c1ae061f93eb7a912618d7ad7abccad845a9d5ba97749c5709401067db70',
    'd6a0a3bf674c4dd754860ffb6bb4013b754460e1cea077f7ac83fb4b2a002cd8',
    '4b77db8d2431d5568aed78f7299e66619a09688da7f3fb7431294b03dae7fd9f',
    '55730410634816ee2657b991a5f410a9cbef4d02ea15d26eee548e4c1d23ccd4',
    'f18d988004f9658edffd4390742a826ef4e748c769d17cb70ed658a1e140e2d9',
    '1e6f98c1134fb2abc44f88a1644fd11a75c6338b882987b188456e6ae0f92e74',
    '331b4edcda3d842029de2c5cb3d9ea23e3752de6ccb10daaa9498d7e7fc69f30',
    'e793b162eda02db9456d9925e37c141f6e61ae86762004200827c84d100d550a',
    'dc5be7cde6e7990a77cff7582b36723484a51f6c3bced25f56fea61d9a75014d',
    '5ab92a1db1816d4940defc690545d1b6aa9f2af1a12bf70e7a4684c9fdab7b79',
    '8a4791ef4cd28d05ec95a9dc0158d8ca5b6c642b9151e466ab2080160f6290ba',
    '6e179c16eed56a08f4ff412e1377fb7e15522eb1eade03e61d61b94fd2fd38b6',
    'd4a4112ce4b2139228200168b1fb891ab9e665880c40b8e4dfa85886948233c1',
    '0af1c10c52b0d13a7bcb79a1b5f0e9ae91ab2967f57a876fa28e913429efb1e4',
    '02c71eed543467e720c52f6654abf80b28449badbd924271e0a1b71d001c34ce',
    'dc4d7d42b3b70be61074e73838f32c44633e224d58b701e6c07b6a662cde9edb',
    '59fc3f2b25727d51f915fbbedc3ba0c176bbbab3e23f35750410d1a7a2dda46b',
    'd94cb86bf0b817bb9ce9ec0ee3bb6be45df480a8471fdafd3023dd6dcbf87753',
    'ca450d342c39aca6cb27ea1be3bbe619a3e4789852f175eb6c8134bc2fcadbf9',
    '606a28c95c29770454fe770d1bde310d770bde41753ae90349c953a02b5d487e',
    'ab6dc44c73dc5b149c390b7805e5cf63848f15e7955eb8a86413e67012adbb90',
    '398abaa082330ad7de4266bd3ea01cfad7a705bde6cd9d968564663d77628b14',
    'c79321e4ca3a88a7a471fc983f728f713feb87a7f8b422c1b73b289b7d13cbc9',
    '6453a8714591438a56d59320a72062e1946a2bcd12583ab1d2ea5254fba13e63',
    '6a935b21e75904132f361d5472da879a2fb6e20ff734f4606fe582ad89b3c7af'
  ]
}

export const consoleVocabulary: DigestVocabulary = {
  terms: [
    '6e9a64cfecd11badcb33a8afa141d7dd422ca46d489d334e8ffa4bf732c03c39',
    '9a86c1ae061f93eb7a912618d7ad7abccad845a9d5ba97749c5709401067db70',
    'd6a0a3bf674c4dd754860ffb6bb4013b754460e1cea077f7ac83fb4b2a002cd8',
    '55730410634816ee2657b991a5f410a9cbef4d02ea15d26eee548e4c1d23ccd4',
    '9a88b87373386022c4156450a0d91fef7f5f2f758687a8ca0540b0e4ce02afbb',
    '02c71eed543467e720c52f6654abf80b28449badbd924271e0a1b71d001c34ce',
    '0f778e3b0028ce22d3aea77893a4fd329087023569479ade262523cb1a28acce',
    '33fa871c93771fc7ad0954be02f180facbf19d8f338f3495cc70d3f3e006cbe2'
  ],
  prefixes: [
    [6, 'c7ba58681b4cc01a5018523897d74ff8211e421a86b739cf943d579f8cdc2829'],
    [8, '81b0814d0e706f6d699e451f2fd25f1bb3c55b84cf2b196ea22e5039cfae5f10'],
    [8, '0db0939df687e5a3dba387c259047ba31e75df883e54e7b6bda3acc36ead81c7'],
    [8, 'b1ff03efebc21f12582a51bd3ce6e5573ae76c2be36d948ba5c6308d99a968bc']
  ]
}

export const brandVocabulary: DigestVocabulary = {
  terms: [
    '5f713191b76deef51141247f735d00c6581774aecefe323d847dfca7d7b929d5'
  ],
  prefixes: [
    [6, '55730410634816ee2657b991a5f410a9cbef4d02ea15d26eee548e4c1d23ccd4']
  ]
}

export const exportVocabulary: DigestVocabulary = {
  terms: [
    '2c2f21625ddb18a305964a68241bf195642d74b31c57fab1c82b1a4969f87cdf'
  ]
}

export const instanceNames = createTermMatcher(instanceVocabulary)
export const consolePrivateTerms = createTermMatcher(consoleVocabulary)
export const privateBrand = createTermMatcher(brandVocabulary)
export const customerTerms = createTermMatcher(mergeVocabularies(instanceVocabulary, consoleVocabulary, brandVocabulary, exportVocabulary))
