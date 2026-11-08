/** ADR 0001 Amendment 1; RFC 0003 findings 9–10. Staging measurement follows in task 5. */
export const QUERY_LIMITS = Object.freeze({
  root: 100, children: 20, relationDepth: 2, filterDepth: 8, nodes: 400,
  relations: 8, exists: 16, fieldRows: 100_000, parents: 100,
  levelRows: 2_000, rows: 5_000, statements: 16, bindings: 100,
  tableReferences: 64, sqlLength: 64_000, inputBytes: 64_000, cursorBytes: 8_000,
})
export interface QueryCost { expressionSources?: number; depth: number; relations: number; fieldRows: number; exists: number; nodes: number }
