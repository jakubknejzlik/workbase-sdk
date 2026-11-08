import type { z } from 'zod'
import type { AtomicOperation, ExecutionContext } from './types'
import { infrastructure } from './context'
import { WorkflowRuntimeNotConfigured } from './errors'
export type WorkflowStatus = 'pending' | 'running' | 'waiting_external' | 'completed' | 'failed' | 'compensating' | 'compensated' | 'needs_attention' | 'cancelled'
export interface WorkflowStepContext {
  context: ExecutionContext; runId: string; input: any; checkpoints: Record<string, unknown>; signal: AbortSignal
}
export interface WorkflowStep {
  id: string
  /** Actual permission checked on every attempt, including compensation. */
  operation: AtomicOperation<any>
  kind?: 'atomic' | 'external'
  policy: { maxAttempts: number; backoffMs: number; timeoutMs: number; deadlineMs: number }
  /** Effects must deduplicate using context.idempotencyKey (atomic) or runId (external). */
  run(context: WorkflowStepContext): Promise<unknown>
  /** Read-only receipt lookup; never issues another business effect. null means uncertain. */
  recover?(context: WorkflowStepContext): Promise<unknown | null>
  /** This step owns the workflow_holds reservation; its undo only releases that hold. */
  holdsCapacity?: boolean
  sideEffect: boolean
  compensate?: { operation: AtomicOperation<any>; run(context: WorkflowStepContext): Promise<unknown> }
}
export interface WorkflowDefinition<S extends z.ZodType = z.ZodType> {
  name: string; version: string; input: S; steps?: readonly WorkflowStep[]
}
export interface WorkflowHandle { id: string }
export interface WorkflowRuntime {
  start<S extends z.ZodType>(workflow: WorkflowDefinition<S>, input: z.output<S>, context: ExecutionContext): Promise<WorkflowHandle>
}
export async function startWorkflow<S extends z.ZodType>(workflow: WorkflowDefinition<S>, input: unknown, context: ExecutionContext): Promise<WorkflowHandle> {
  const { workflowRuntime } = infrastructure(context)
  if (!workflowRuntime) throw new WorkflowRuntimeNotConfigured()
  return workflowRuntime.start(workflow, workflow.input.parse(input), context)
}
