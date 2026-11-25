import { z } from 'zod'
import { changeSchema, compositionChangeSchema, schemaChangeSchema, fail, isPresentationChange } from './schemas.ts'

export type Eligibility = { eligible: true } | { eligible: false; error: { code: string; message: string; status: number } }
export const eligible: Eligibility = { eligible: true }
export const ineligible = (code: string, message: string, status = 409): Eligibility => ({ eligible: false, error: { code, message, status } })
export function assertEligible(decision: Eligibility) {
  if (!decision.eligible) fail(decision.error.code, decision.error.message, decision.error.status)
}
/** Enumerate only top-level change discriminants, not nested constraint/plugin kinds. */
export function schemaKinds(schema: z.ZodType): string[] {
  const visit = (node: Record<string, any>): string[] => [
    ...(typeof node.properties?.kind?.const === 'string' ? [node.properties.kind.const] : []),
    ...(node.properties?.kind?.enum ?? []),
    ...['anyOf', 'oneOf', 'allOf'].flatMap(key => (node[key] ?? []).flatMap(visit)),
  ]
  return [...new Set(visit(z.toJSONSchema(schema, { io: 'input' })))].sort()
}
export const changeKinds = [...new Set([changeSchema, compositionChangeSchema, schemaChangeSchema].flatMap(schemaKinds))].sort()
const compositionKinds = new Set(schemaKinds(compositionChangeSchema))
const schemaChangeKinds = new Set(schemaKinds(schemaChangeSchema))
type Kind = { kind: string }
export type ChangeRoute = 'legacy' | 'composition' | 'schema'

/** Dispatch before Store.load: these handlers own their source-loading diagnostics. */
export function earlyChangeRoute(changes: readonly Kind[]): ChangeRoute | undefined {
  if (changes.some(change => schemaChangeKinds.has(change.kind))) {
    if (!changes.every(change => schemaChangeKinds.has(change.kind))) fail('mixed_change_kinds', 'Propose constraints separately from other changes')
    return 'schema'
  }
  if (changes.some(change => !['set_locale', 'set_label'].includes(change.kind) && compositionKinds.has(change.kind))) {
    if (!changes.every(change => compositionKinds.has(change.kind))) fail('mixed_change_kinds', 'Composition and legacy config changes must be proposed separately')
    return 'composition'
  }
}
export function changeRoute(baseline: string | undefined, changes: readonly Kind[]): ChangeRoute {
  const early = earlyChangeRoute(changes)
  if (early) return early
  if (baseline === 'workbase-sdk' && changes.some(isPresentationChange)) {
    if (!changes.every(isPresentationChange)) fail('mixed_change_kinds', 'Propose V3 language changes separately from legacy config changes')
    return 'composition'
  }
  return 'legacy'
}
export function compositionEligibility(baseline: string | undefined, changes: readonly Kind[]): Eligibility {
  if (changes.some(isPresentationChange) && !changes.every(isPresentationChange)) return ineligible('mixed_change_kinds', 'Propose V3 presentation changes separately from runtime and access changes', 400)
  return baseline === 'workbase-sdk' ? eligible : ineligible('composition_requires_v3', 'Composition authoring requires a V3 instance')
}
export function schemaEligibility(baseline: string | undefined): Eligibility {
  return baseline === 'workbase-sdk' ? eligible : ineligible('schema_requires_v3', 'Constraint authoring requires authored V3 schema files')
}
/** Shared first submit gate; later proof/configuration gates remain distinct. */
export function submissionPromotionEligibility(status: string): Eligibility {
  return status === 'promoted' ? eligible : ineligible('promotion_required', 'Změna musí být nejprve povýšena pomocí promote.')
}
