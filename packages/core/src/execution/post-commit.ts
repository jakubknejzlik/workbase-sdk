import type { AtomicOperation, AtomicResult } from './types'

// Internal lifecycle seam: callbacks are registered by core, outside declarative
// plans. Prepared credentials never enter config, receipts or serialized plans.
type PostCommit = (prepared: any, result: AtomicResult) => Promise<AtomicResult>
const callbacks = new WeakMap<AtomicOperation['plan'], PostCommit>()
export function registerPostCommit<T extends AtomicOperation<any>>(operation: T, callback: (prepared: Awaited<ReturnType<NonNullable<T['prepare']>>>, result: AtomicResult) => Promise<AtomicResult>): T {
  callbacks.set(operation.plan, callback)
  return operation
}
export const postCommitFor = (operation: AtomicOperation) => callbacks.get(operation.plan)
