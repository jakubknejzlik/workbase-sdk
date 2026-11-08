import type { Scope } from './identity'
/** Core-private credential provenance, preserved only by trusted context/live-scope builders. */
export const scopeOperations = new WeakMap<Scope, { operations: string[] | null }>()
