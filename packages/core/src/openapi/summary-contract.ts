/** Detached JSON fragments only; no registration in served OpenAPI or MCP.
 * Local recursive refs remain fragment-local; rebase them when embedding later.
 * Runtime uniqueness and time arithmetic still require the plain parse functions.
 */
export { projectSummaryContract as summaryContract } from '../query/summary-schema'
