import { z } from 'zod'
import { createCommandRegistry } from '../../../src/commands'
import { createWorkflowRegistry } from '../../../src/workflow-runtime'
import type { AtomicOperation } from '../../../src/execution/types'

const reportInput = z.strictObject({ id: z.string(), name: z.string() })
export const renameReport: AtomicOperation<typeof reportInput> = {
  name: 'reports/rename', permission: { entity: 'reports', operation: 'update' },
  input: reportInput,
  plan(_context, input) { return { rules: [{ name: 'rename_report', statements: [{ sql: 'UPDATE reports SET name=? WHERE id=?', bindings: [input.name, input.id], expectRows: 1 }] }], result: { status: 200, body: { ok: true } }, event: { operation: 'reports.renamed', entity: 'reports', entityId: input.id } } },
}
export const commands = createCommandRegistry([renameReport])
export const workflows = createWorkflowRegistry([{ name: 'reports/reconcile', version: '1', input: z.strictObject({}), steps: [{
  id: 'reconcile', operation: renameReport, sideEffect: false, policy: { maxAttempts: 1, backoffMs: 0, timeoutMs: 1000, deadlineMs: 10000 }, run: async () => ({ ok: true }),
}] }])
