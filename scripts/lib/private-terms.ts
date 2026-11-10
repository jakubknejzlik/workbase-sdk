import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import requiredDigests from './private-term-digests.json'

const salt = '61344a8704e93d59-dd38a3ed8094ec1c'
// Completeness requires the exact spelling used to build every guard regex.
export const termDigest = (value: string) => createHash('sha256').update(salt + '\0' + value).digest('hex')
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
