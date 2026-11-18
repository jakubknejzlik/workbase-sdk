import type { InstanceConfig } from './config'
import { ApiError } from './errors'

/** Match only SQLite's bounded column identity diagnostic, including D1's
 * wrapper/cause. Trigger text, values and arbitrary index names are never codes.
 * Unknown database constraints retain the adapter's generic conflict fallback.
 */
export function uniqueConflict(error: unknown, config: InstanceConfig): ApiError | undefined {
  const messages: string[] = []
  let current = error
  const seen = new Set<unknown>()
  for (let i = 0; i < 4 && current instanceof Error && !seen.has(current); i++) {
    seen.add(current)
    if (current.message.length <= 4096) messages.push(current.message)
    current = current.cause
  }
  const identities = new Set<string>()
  for (const message of messages) {
    const match = /^(?:D1_ERROR: )?UNIQUE constraint failed: ([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*(?:, [a-z][a-z0-9_]*\.[a-z][a-z0-9_]*){0,16})(?:: SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_UNIQUE\))?)?$/.exec(message)
    if (match) identities.add(match[1])
  }
  if (identities.size !== 1) return
  const identity = [...identities][0]
  const candidates = Object.entries(config.entities).flatMap(([entity, spec]) => (spec.constraints ?? []).flatMap(constraint => {
    const columns = ['organization_id', ...constraint.fields].map(field => `${entity}.${field}`).join(', ')
    return columns === identity ? [`${entity}.${constraint.name}`] : []
  }))
  if (!candidates.length) return
  return new ApiError(409, 'unique_conflict', undefined, candidates.length === 1 ? { constraintId: candidates[0] } : undefined)
}
