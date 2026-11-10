import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import requiredDigests from './private-term-digests.json'

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
// Canonicalisation is only for completeness digests, never scanned content.
const normalize = (value: string) => foldCase(value.normalize('NFC'))
const hashTerm = (canonical: string) => createHash('sha256').update(salt + '\0' + canonical).digest('hex')
export const termDigest = (value: string) => hashTerm(normalize(value))
// Reviews hash exact bytes: changes in case, whitespace or path still need review.
export const reviewDigest = (value: string) => createHash('sha256').update(salt + '\0review\0' + value).digest('hex')
const incomplete = 'private terms not provided / incomplete; set WORKBASE_PRIVATE_TERMS'
type PrivateTermsEnv = Partial<Pick<NodeJS.ProcessEnv, 'WORKBASE_PRIVATE_TERMS' | 'WORKBASE_PRIVATE_TERMS_FILE'>>

// The manifest's order is part of the private configuration: regex slots follow
// the base vocabulary, with additional literals appended after the required slots.
export function loadPrivateTerms(env: PrivateTermsEnv = process.env, required: readonly string[] = requiredDigests): string[] {
  let input = env.WORKBASE_PRIVATE_TERMS
  if (!input && env.WORKBASE_PRIVATE_TERMS_FILE) {
    try { input = readFileSync(env.WORKBASE_PRIVATE_TERMS_FILE, 'utf8') }
    catch { throw new Error(incomplete + ' (unable to read WORKBASE_PRIVATE_TERMS_FILE)') }
  }
  const terms = (input ?? '').split(/\r?\n/).map(term => term.trim()).filter(Boolean)
  const supplied = terms.map(termDigest)
  const suppliedDigests = new Set(supplied)
  if (!terms.length || required.some(digest => !suppliedDigests.has(digest))) throw new Error(incomplete)
  if (required.some((digest, index) => supplied[index] !== digest)) throw new Error(incomplete + ' (preserve term #N order; append extra terms)')
  return terms
}
