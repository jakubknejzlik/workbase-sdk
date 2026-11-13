import { z } from 'zod'
import type { InstanceConfig } from './config'

export const recordActionsSchema = z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.strictObject({
  command: z.string().min(1),
  available: z.array(z.strictObject({ when: z.record(z.string(), z.unknown()), reason: z.string().regex(/^[\w-]+(?:\.[\w-]+)+$/) })).optional(),
}))
type Operators = { eq?: unknown; ne?: unknown; in?: readonly unknown[]; lt?: unknown; lte?: unknown; gt?: unknown; gte?: unknown; contains?: string; isNull?: boolean }
export type ActionWhen<E extends { fields: object; relations?: object }> = {
  [K in keyof E['fields'] | 'id' | 'organization_id' | 'created_at' | 'updated_at' | 'version']?: Operators
} & { [K in keyof NonNullable<E['relations']>]?: Record<string, unknown> } & {
  use?: string; actorLinkedIn?: string; and?: ActionWhen<E>[]; or?: ActionWhen<E>[]; not?: ActionWhen<E>
}
/** Finite, untranslated keys for dictionary validation; no console dependency. */
export function actionReasonKeys(config: InstanceConfig): string[] {
  return [...new Set(config.effectiveAccess?.actions.flatMap(action => action.conditions.map(condition => condition.reason)) ?? [])].sort()
}
