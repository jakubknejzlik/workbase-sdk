import { z } from 'zod'
import { defineAtomicOperation } from '@workbasehq/core/execution/atomic'
import { counterCommands } from '../../../core/test/fixtures/sample/commands'
import { executeAtomic } from '@workbasehq/core/execution/atomic'
import type { WorkflowDefinition } from '../../../core/src/execution/workflow'

export const transition = defineAtomicOperation({
  name: 'jobs/transition', permission: { entity: 'jobs', operation: 'update' }, idempotency: 'required',
  input: z.strictObject({ jobId: z.string(), to: z.enum(['draft', 'scheduled', 'done']) }),
  plan: (context, input) => ({
    rules: [{ name: 'update', statements: [{ sql: 'UPDATE jobs SET status=?,version=version+1 WHERE organization_id=? AND id=?', bindings: [input.to, context.scope.organizationId, input.jobId], expectRows: 1 }] }],
    result: { status: 200, body: { id: input.jobId, status: input.to } },
    event: { entity: 'jobs', entityId: input.jobId, operation: 'job.transitioned' },
  }),
})
// Small executable updates keep every neutral domain's command round trip meaningful.
const updateField = (entity: string, action: string, field: string, value: z.ZodType<string> = z.string().min(1)) => defineAtomicOperation({
  name: `${entity}/${action}`, permission: { entity, operation: 'update' },
  input: z.strictObject({ id: z.string().meta({ referenceEntity: entity }), value }),
  plan: (context, input) => ({
    rules: [{ name: 'update', statements: [{
      sql: `UPDATE ${entity} SET ${field}=?,updated_at=?,version=version+1 WHERE organization_id=? AND id=?`,
      bindings: [input.value, context.now, context.scope.organizationId, input.id], expectRows: 1,
    }] }],
    result: { status: 200, body: { id: input.id, [field]: input.value } },
    event: { entity, entityId: input.id, operation: `${entity}.${action}` },
  }),
})
export const commands = [...counterCommands.values(), transition,
  updateField('jobs', 'rename', 'title'),
  updateField('clients', 'rename', 'name'),
  updateField('workers', 'rename', 'name'),
]
export const secondaryCommands = [updateField('tasks', 'rename', 'title')]
export const quaternaryCommands = [...commands,
  updateField('stock_items', 'rename', 'name'),
  updateField('jobs', 'prioritize', 'priority', z.enum(['low', 'normal', 'high'])),
  updateField('slots', 'reschedule', 'starts_at', z.iso.datetime()),
  updateField('clients', 'change_email', 'email', z.email()),
]
const create = counterCommands.get('bookings/create')!
const cancel = counterCommands.get('bookings/cancel')!
export const workflow: WorkflowDefinition = {
  name: 'bookings/reserve', version: '1', input: z.strictObject({ slotId: z.string(), clientId: z.string() }),
  steps: [{ id: 'reserve', operation: create, sideEffect: true,
    policy: { maxAttempts: 1, backoffMs: 0, timeoutMs: 3000, deadlineMs: 3000 },
    run: ({ context, input }) => executeAtomic(create, input, context),
    compensate: { operation: cancel, run: async ({ context, checkpoints }) => {
      if (!checkpoints.reserve) return
      const receipt = z.object({ body: z.object({ id: z.string() }) }).parse(checkpoints.reserve)
      return executeAtomic(cancel, { bookingId: receipt.body.id }, context)
    } },
  }],
}
