import { z } from 'zod'

const identifier = z.string().regex(/^[a-z][a-z0-9_]*$/)
export const MAX_UNIQUE_CONSTRAINT_FIELDS = 16
/** Equality to one non-null scalar literal. NULL predicates and SQL expressions
 * are intentionally outside this contract; NULL tuple entries remain distinct. */
export const uniquePredicateSchema = z.strictObject({
  field: identifier, op: z.literal('eq'), value: z.union([z.string().refine(value => !value.includes('\u0000'), 'SQL literals cannot contain NUL'), z.number().finite(), z.boolean()]),
})
/** Discriminated data contract: future kinds can add their own typed payloads.
 * NULLs are distinct: a tuple containing any NULL does not conflict. All stored
 * scalar field types are supported; mixed types occupy separate tuple positions.
 * Organization scope is supplied by the SDK and cannot be authored here.
 */
export const entityConstraintSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('unique'), name: identifier.max(63), fields: z.array(identifier).min(1).max(MAX_UNIQUE_CONSTRAINT_FIELDS), where: uniquePredicateSchema.optional() }),
])
export const entityConstraintsSchema = z.array(entityConstraintSchema).max(32)
export type EntityConstraint = z.infer<typeof entityConstraintSchema>

/** SQLite's generated column identity includes the SDK-owned organization scope. */
export function uniqueConstraintIdentity(entity: string, fields: readonly string[]) {
  return ['organization_id', ...fields].map(field => `${entity}.${field}`).join(', ')
}

/** Shared by the literal DSL, normalized configs and lock validation. */
export function validateEntityConstraints(constraints: readonly EntityConstraint[], fields: Record<string, { computed?: unknown; implicit?: boolean; type?: string; values?: string[]; sqlType?: string; checks?: string[] }>, fail: (path: (string | number)[], message: string) => never) {
  const names = new Set<string>()
  for (const [i, constraint] of constraints.entries()) {
    if (names.has(constraint.name)) fail([i, 'name'], 'Duplicate constraint name')
    names.add(constraint.name)
    const seen = new Set<string>()
    for (const [j, key] of constraint.fields.entries()) {
      if (seen.has(key)) fail([i, 'fields', j], 'Constraint fields must be distinct')
      seen.add(key)
      if (!Object.hasOwn(fields, key)) fail([i, 'fields', j], 'Unknown constraint field')
      if (fields[key].computed || fields[key].implicit) fail([i, 'fields', j], 'Constraint fields must be stored authored fields')
    }
    if (constraint.where) {
      const { field: key, value } = constraint.where
      if (!Object.hasOwn(fields, key)) fail([i, 'where', 'field'], 'Unknown predicate field')
      const field = fields[key]
      if (field.computed || field.implicit) fail([i, 'where', 'field'], 'Predicate field must be a stored authored field')
      // Locks carry physical types/checks rather than logical field metadata.
      const bool = field.type === 'bool' || field.checks?.includes(`"${key}" IN (0,1)`)
      const type = field.type ?? (bool ? 'bool' : field.sqlType === 'INTEGER' ? 'int' : field.sqlType === 'REAL' ? 'float' : 'text')
      const compatible = type === 'bool' ? typeof value === 'boolean'
        : type === 'int' ? typeof value === 'number' && Number.isSafeInteger(value)
        : type === 'float' ? typeof value === 'number' && Number.isFinite(value)
        : typeof value === 'string' && (type !== 'enum' || !!field.values?.includes(value))
      if (!compatible) fail([i, 'where', 'value'], 'Predicate requires a type-compatible literal (enum values must be declared)')
      if (!field.type && typeof value === 'string') {
        const enumCheck = field.checks?.find(check => check.startsWith(`"${key}" IN (`))
        if (enumCheck) {
          const literals: string[] = enumCheck.match(/'(?:[^']|'')*'/g) ?? []
          if (!literals.includes(`'${value.replaceAll("'", "''")}'`)) fail([i, 'where', 'value'], 'Predicate requires a type-compatible enum literal')
        }
      }
    }
  }
}
/** Injective table/name identity in SQLite's global index namespace. */
export function uniqueIndexName(table: string, name: string) {
  const seed = Array.from(table, c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
  return `workbase_unique_${seed}_${name}`
}
