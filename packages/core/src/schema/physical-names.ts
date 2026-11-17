import { validateLock } from './lock-format'

/** Snapshot a validated lock. Public names locate immutable IDs; SQL consumers
 * resolve those IDs to the pinned physical names. No compiler is rewired yet. */
export function createPhysicalNameResolver(input: unknown) {
  const lock = validateLock(input)
  const entity = (id: string) => {
    const found = lock.entities.find(e => e.id === id)
    if (!found) throw new Error(`Unknown entity ID: ${id}`)
    return found
  }
  return {
    entityId(logicalName: string): string {
      const found = lock.entities.find(e => e.logicalName === logicalName)
      if (!found) throw new Error(`Unknown logical entity: ${logicalName}`)
      return found.id
    },
    fieldId(entityId: string, logicalName: string): string {
      const found = entity(entityId).fields.find(f => f.logicalName === logicalName)
      if (!found) throw new Error(`Unknown logical field: ${entityId}.${logicalName}`)
      return found.id
    },
    table(entityId: string): string { return entity(entityId).physicalName },
    column(entityId: string, fieldId: string): string {
      const found = entity(entityId).fields.find(f => f.id === fieldId)
      if (!found) throw new Error(`Unknown field ID: ${entityId}.${fieldId}`)
      return found.physicalName
    },
  }
}
