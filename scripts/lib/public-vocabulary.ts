import { loadPrivateTerms } from './private-terms'
export { reviewDigest, termDigest } from './private-terms'

const escape = (term: string) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The first 36 external slots replace the literals at 33fef26, in their original
// order. These are ordinary regexes: no input folding, NFC or hash-based matching.
// Keep each expression's grouping, flags and boundaries identical to that base.
export function buildGuardRegexes(terms: readonly string[]) {
  if (terms.length < 36) throw new Error('private terms not provided / incomplete; set WORKBASE_PRIVATE_TERMS')
  const term = (number: number) => escape(terms[number - 1])
  const extra = terms.slice(36).map(escape)
  const expression = (source: string, flags: string) => new RegExp([source, ...extra].join('|'), flags)
  const escapedTerms = terms.slice(0, 27).map(escape)
  const instanceNames = expression(`(?<![\\p{L}\\p{N}_])(?:${escapedTerms.join('|')})(?![\\p{L}\\p{N}_])`, 'iu')
  const consolePrivateTerms = expression(`${term(1)}|${term(2)}|${term(4)}|${term(6).replace('-', '[-_]')}|${term(28)}|${term(29)}|${term(30)}|${term(31)}|\\b(?:${term(3)}|${term(32)}|${term(33)}|${term(34)})\\b`, 'i')
  const privateBrand = expression(`${term(1)}(?:${escape(terms[34].slice(terms[0].length))})?`, 'iu')
  const customerTerms = new RegExp([consolePrivateTerms.source, instanceNames.source, privateBrand.source, term(36), ...extra].join('|'), 'iu')
  const mcpTerms = expression(`workspace:|file:|overrides|tarball|public-console|BOOTSTRAP GAP|${term(32)}|${term(3)}|${term(1)}|${term(2)}|packages\\/core\\/src`, 'i')
  return { instanceNames, consolePrivateTerms, privateBrand, customerTerms, mcpTerms }
}

export const { instanceNames, consolePrivateTerms, privateBrand, customerTerms, mcpTerms } = buildGuardRegexes(loadPrivateTerms())
