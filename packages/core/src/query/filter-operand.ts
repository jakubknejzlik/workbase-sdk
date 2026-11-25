/** Internal classification shared with the console; validation still owns types and limits.
 * Scalar operators have leaf values; relation predicates have nested filter objects.
 * Empty objects belong only to relations. Mixed/ambiguous operands are invalid
 * (query_invalid at the public query boundary), never an implicit conjunction.
 */
export function filterOperand(hasField: boolean, hasRelation: boolean, value: unknown): 'scalar' | 'relation' | 'invalid' {
  if (!hasRelation) return hasField ? 'scalar' : 'invalid'
  if (!hasField) return 'relation'
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'invalid'
  const entries = Object.entries(value)
  const leaf = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v)
  const scalar = entries.length > 0 && entries.every(([key, operand]) =>
    ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains', 'isNull'].includes(key) ? leaf(operand)
      : key === 'in' && Array.isArray(operand) && operand.every(leaf))
  const relation = entries.every(([key, operand]) => key === 'and' || key === 'or' ? Array.isArray(operand)
    : key === 'actorLinkedIn' ? typeof operand === 'string'
    : !!operand && typeof operand === 'object' && !Array.isArray(operand))
  return scalar === relation ? 'invalid' : scalar ? 'scalar' : 'relation'
}
