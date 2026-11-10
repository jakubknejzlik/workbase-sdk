import assert from 'node:assert/strict'
import { customerTerms, type TermMatcher } from './public-vocabulary'

export function assertGeneratedMcpContent(path: string, content: string, vocabulary: TermMatcher = customerTerms) {
  assert(!/workspace:|file:|overrides|tarball|public-console|BOOTSTRAP GAP|packages\/core\/src/i.test(content)
    && !vocabulary.test(path) && !vocabulary.test(content), `Forbidden generated content: ${path}`)
  assert(!/\{\{(?:SDK_VERSION|INSTANCE_ID|INSTANCE_SELECTOR)\}\}/.test(content), `Unresolved placeholder: ${path}`)
}
