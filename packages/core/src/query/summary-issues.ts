const issueMessages = Object.freeze({
  invalid_type: 'Invalid summary type',
  invalid_value: 'Unsupported summary value',
  invalid_union: 'Unsupported summary variant',
  invalid_format: 'Invalid summary format',
  too_big: 'Summary limit exceeded',
  too_small: 'Summary minimum not met',
  unrecognized_keys: 'Unknown summary properties are unsupported',
  custom: 'Invalid summary constraint',
  invalid_key: 'Invalid summary key',
  invalid_element: 'Invalid summary element',
  not_multiple_of: 'Invalid summary multiple',
  invalid_summary: 'Invalid summary',
})
const operandMessages = Object.freeze({
  reference: 'Summary reference operands are unsupported',
  computed: 'Summary computed operands are unsupported',
  expression: 'Summary expressions are unsupported',
  unknown_field: 'Unknown summary field',
  unsupported_type: 'Unsupported summary field type',
})
export type SummaryOperandReason = keyof typeof operandMessages
export type SafeIssue = {
  code: keyof typeof issueMessages
  path: (string | number)[]
  message: string
  reason?: SummaryOperandReason
}
const pathKeys = new Set(['entity', 'where', 'summary', 'version', 'metrics', 'groupBy', 'window', 'maxGroups',
  'op', 'alias', 'field', 'from', 'to', 'timeZone', 'bucket', 'kind', 'data', 'groups'])

// Boundary invariant: BOTH plain parse functions accept no Zod settings/callbacks
// and finalize with an SDK-owned constant error map that preempts global hooks,
// including nested union issues. No consumer sees raw issues before this mapper.
// Rebuild EVERY issue here; never return Zod errors or expose parseable schemas:
// annotations/clones cannot bypass this mapper.
// Codes/reasons require own-property membership, including future/unknown codes.
// Never copy input, received, keys, options, raw messages or any unknown fields.
export function summaryIssue(issue: { code?: unknown; path?: readonly unknown[] }, reason?: SummaryOperandReason): SafeIssue {
  const code = typeof issue.code === 'string' && Object.hasOwn(issueMessages, issue.code)
    ? issue.code as keyof typeof issueMessages : 'invalid_summary'
  const path = issue.path ?? []
  const safe: SafeIssue = {
    code,
    path: path.map((segment, index) => {
      if (typeof segment === 'number' && Number.isSafeInteger(segment) && segment >= 0) return segment
      // Map and predicate keys remain input-derived even if spelled like tokens.
      const dynamic = (path[0] === 'where' && index > 0)
        || (path[0] === 'data' && (path[2] === 'groups' || path[2] === 'metrics') && index > 2)
      return !dynamic && typeof segment === 'string' && pathKeys.has(segment) ? segment : '[key]'
    }),
    message: issueMessages[code],
  }
  if (code === 'invalid_value' && reason && Object.hasOwn(operandMessages, reason)) {
    safe.reason = reason
    safe.message = operandMessages[reason]
  }
  return safe
}
