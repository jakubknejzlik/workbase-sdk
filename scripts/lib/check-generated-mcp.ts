import assert from 'node:assert/strict'
import { mcpTerms } from './public-vocabulary'

export function assertGeneratedMcpContent(path: string, content: string, vocabulary: RegExp = mcpTerms) {
  assert(!vocabulary.test(content), `Forbidden generated content: ${path}`)
  assert(!/\{\{(?:SDK_VERSION|INSTANCE_ID|INSTANCE_SELECTOR)\}\}/.test(content), `Unresolved placeholder: ${path}`)
}
