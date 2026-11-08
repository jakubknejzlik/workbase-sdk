import type { Operation } from '../config'

/** Keep the existing exact allowlist vocabulary for CRUD, registered commands and resources. */
export function operationName(target: { entity: string; operation: Operation } | { name: string } | { system: string }): string {
  if ('name' in target) return target.name
  if ('system' in target) return target.system
  return `${target.entity}.${target.operation}`
}
