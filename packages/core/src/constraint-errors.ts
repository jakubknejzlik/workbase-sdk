import type { InstanceConfig } from './config'
import { ApiError } from './errors'
import { MAX_UNIQUE_CONSTRAINT_FIELDS, uniqueConstraintIdentity, refEqualityToken } from './entity-constraints'

const d1Prefix = 'D1_ERROR: '
const sqlitePrefix = 'UNIQUE constraint failed: '
const sqliteSuffix = ': SQLITE_CONSTRAINT'
const extendedSuffix = ' (extended: SQLITE_CONSTRAINT_UNIQUE)'
const identityPattern = new RegExp(String.raw`^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*(?:, [a-z][a-z0-9_]*\.[a-z][a-z0-9_]*){0,${MAX_UNIQUE_CONSTRAINT_FIELDS}}$`)

/** Match only SQLite's bounded column identity diagnostic, including D1's
 * wrapper/cause. Trigger text, values and arbitrary index names are never codes.
 * Unknown database constraints retain the adapter's generic conflict fallback.
 */
export function uniqueConflict(error: unknown, config: InstanceConfig): ApiError | undefined {
  const declared = Object.entries(config.entities).flatMap(([entity, spec]) => (spec.constraints ?? []).filter(c => c.kind === 'unique').map(constraint => ({
    identity: uniqueConstraintIdentity(entity, constraint.fields), id: `${entity}.${constraint.name}`,
  })))
  if (!declared.length) return
  // Identifier lengths are unbounded in declarations. Bound parsing by the
  // longest declared identity plus the exact accepted wrapper, so every valid
  // generated identity fits. The tuple limit is shared with declaration validation.
  const maxMessageLength = declared.reduce((max, c) => Math.max(max, c.identity.length), 0)
    + d1Prefix.length + sqlitePrefix.length + sqliteSuffix.length + extendedSuffix.length
  const messages: string[] = []
  let current = error
  const seen = new Set<unknown>()
  for (let i = 0; i < 4 && current instanceof Error && !seen.has(current); i++) {
    seen.add(current)
    if (current.message.length <= maxMessageLength) messages.push(current.message)
    current = current.cause
  }
  const identities = new Set<string>()
  for (const message of messages) {
    let identity = message.startsWith(d1Prefix) ? message.slice(d1Prefix.length) : message
    if (!identity.startsWith(sqlitePrefix)) continue
    identity = identity.slice(sqlitePrefix.length)
    if (identity.endsWith(sqliteSuffix + extendedSuffix)) identity = identity.slice(0, -sqliteSuffix.length - extendedSuffix.length)
    else if (identity.endsWith(sqliteSuffix)) identity = identity.slice(0, -sqliteSuffix.length)
    if (identityPattern.test(identity)) identities.add(identity)
  }
  if (identities.size !== 1) return
  const identity = [...identities][0]
  const candidates = declared.filter(constraint => constraint.identity === identity).map(constraint => constraint.id)
  if (!candidates.length) return
  return new ApiError(409, 'unique_conflict', undefined, candidates.length === 1 ? { constraintId: candidates[0] } : undefined)
}

/** Exact SDK-generated tokens only; bounded cause traversal and declared identity
 * bound message lengths. No substring matching or arbitrary database prose. */
export function refEqualityMismatch(error: unknown, config: InstanceConfig): ApiError | undefined {
  const declared = Object.entries(config.entities).flatMap(([entity, spec]) => (spec.constraints ?? []).filter(c => c.kind === 'ref_equality').map(c => ({ token: refEqualityToken(entity, c.name), id: `${entity}.${c.name}` })))
  const matches = new Set<string>(), seen = new Set<unknown>()
  const maxLength = declared.reduce((n, c) => Math.max(n, c.token.length), 0) + 100
  let current = error
  for (let i = 0; i < 4 && current instanceof Error && !seen.has(current); i++) {
    seen.add(current)
    if (current.message.length <= maxLength) {
      let token = current.message.startsWith(d1Prefix) ? current.message.slice(d1Prefix.length) : current.message
      const extended = ': SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)'
      if (token.endsWith(extended)) token = token.slice(0, -extended.length)
      else if (token.endsWith(sqliteSuffix)) token = token.slice(0, -sqliteSuffix.length)
      for (const constraint of declared) if (constraint.token === token) matches.add(constraint.id)
    }
    current = current.cause
  }
  if (matches.size === 1) return new ApiError(422, 'ref_equality_mismatch', undefined, { constraintId: [...matches][0] })
}
export function constraintError(error: unknown, config: InstanceConfig): ApiError | undefined {
  return refEqualityMismatch(error, config) ?? uniqueConflict(error, config)
}
