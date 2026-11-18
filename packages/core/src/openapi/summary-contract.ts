import type { InstanceConfig } from '../config'
import { summaryQuerySchema, summaryResultSchema, type SummaryOptions } from '../query/summary-schema'
import { publicInputSchema } from './input-projection'

/** Detached component fragments only. No registration in served OpenAPI or MCP.
 * Local recursive refs remain fragment-local; rebase them when embedding later.
 * Zod refinements (unique aliases, time arithmetic, etc.) require runtime validation.
 */
export function summaryContract<C extends InstanceConfig, E extends keyof C['entities'] & string, const S extends SummaryOptions<C, E>>(
  config: C, entity: E, summary: S,
) {
  return {
    request: publicInputSchema(summaryQuerySchema(config, entity)),
    result: publicInputSchema(summaryResultSchema(config, entity, summary)),
  }
}
