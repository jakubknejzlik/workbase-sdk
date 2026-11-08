import { kernelFor } from './kernel/registry'
import { z } from 'zod'
import { coreExecutionContext } from './execution/context'
import { D1AtomicStore, D1AtomicReader } from './execution/d1'
import type { InstanceConfig } from './config'
import type { App, AppContext, RuntimeEnv } from './types'
import { ApiError } from './errors'
import { requireScope } from './authorization'
import { atomicPermission } from './execution/permissions'
import { authorizeReceiptRows, needsPolicyReceipt } from './execution/policy-receipts'
import type { WorkflowDefinition } from './execution/workflow'
import { startWorkflow } from './execution/workflow'
import { D1WorkflowRuntime, workflowSignature, type WorkflowRegistry } from './workflow-runtime'
export function workflowRoutes(app: App, config: InstanceConfig, env: RuntimeEnv, definitions: WorkflowRegistry) {
  const runtime = new D1WorkflowRuntime(env, config, definitions)
  const context = (scope: Awaited<ReturnType<typeof requireScope>>, key?: string) => coreExecutionContext(config, scope, new D1AtomicStore(env.DB, { env, config }), new D1AtomicReader(env.DB), key, runtime)
  app.post('/internal/workflows/run', async c => c.json(await runtime.tick()))
  const scopeFor = async (c: AppContext, name?: string) => {
    const scope = await requireScope(await kernelFor(config).requireActor(c.req.raw, env), c.req.header('X-Organization-Id') ?? '', config, c.get('correlationId'), name)
    c.set('scope', scope)
    return scope
  }
  const reader = async (c: AppContext) => {
    const actor = await kernelFor(config).requireActor(c.req.raw, env)
    const organizationId = c.req.header('X-Organization-Id') ?? ''
    c.set('scope', await requireScope(actor, organizationId, config, c.get('correlationId')))
    return workflowReader(config, env, definitions, actor, organizationId, c.get('correlationId'))
  }
  const lookup = async (id: string, org: string) => lookupWorkflow(env, id, org)
  app.get('/workflows', async c => c.json({ data: await (await reader(c)).list(c.req.query('status')) }))
  app.get('/workflows/:id', async c => c.json(await (await reader(c)).detail(c.req.param('id'))))
  app.post('/workflows/:id/resume', async c => {
    const scope = await scopeFor(c)
    if (scope.actor.type !== 'user' || scope.role !== 'owner') throw new ApiError(403, 'owner_required')
    kernelFor(config).resourcePermission(scope, 'workflows.resume')
    await lookup(c.req.param('id'), scope.organizationId)
    const status = await runtime.resume(c.req.param('id'), context(scope))
    return c.json({ id: c.req.param('id'), status }, 202)
  })
  app.post('/workflows/:id/cancel', async c => {
    const scope = await scopeFor(c)
    if (scope.actor.type !== 'user' || scope.role !== 'owner') throw new ApiError(403, 'owner_required')
    kernelFor(config).resourcePermission(scope, 'workflows.cancel')
    await lookup(c.req.param('id'), scope.organizationId)
    const status = await runtime.cancel(c.req.param('id'), context(scope))
    return c.json({ id: c.req.param('id'), status }, status === 'cancelled' ? 200 : 202)
  })
  // Names may include slashes, like commands; register after resume and GET routes.
  app.post('/workflows/*', async c => {
    const name = c.req.path.slice('/workflows/'.length)
    const definition = definitions.get(name)
    if (!definition) throw new ApiError(404, 'workflow_not_found')
    const scope = await (await reader(c)).startScope(definition)
    const { idempotencyKey, ...input } = z.record(z.string(), z.unknown()).parse(await c.req.json())
    const bodyKey = z.string().min(1).max(128).optional().parse(idempotencyKey)
    const headerKey = c.req.header('Idempotency-Key')
    if (headerKey && bodyKey && headerKey !== bodyKey) throw new ApiError(422, 'idempotency_payload_mismatch')
    const handle = await startWorkflow(definition, input, context(scope, headerKey ?? bodyKey))
    const row = await lookup(handle.id, scope.organizationId)
    return c.json({ id: handle.id, status: row.status }, 202)
  })
}

/** Shared authorized reads. Browser-only projections add safe metadata, never stored input or credentials. */
export function workflowReader(config: InstanceConfig, env: RuntimeEnv, definitions: WorkflowRegistry,
  actor: import('./types').ResolvedActor, organizationId: string, correlationId: string) {
  const scopeFor = (name?: string) => requireScope(actor, organizationId, config, correlationId, name)
  const readScope = async () => {
    const scope = await scopeFor()
    kernelFor(config).resourcePermission(scope, 'workflows.read')
    return scope
  }
  const startScope = async (definition: WorkflowDefinition<any>) => {
    let scope = await scopeFor()
    for (const step of definition.steps!) { scope = await scopeFor(step.operation.name); atomicPermission(config, scope, step.operation) }
    return scope
  }
  const authorize = async (row: Record<string, any>) => {
    const scope = await readScope()
    if (scope.actor.type === 'user' && scope.role === 'owner') return
    const definition = definitions.get(row.definition_name)
    if (!definition || definition.version !== row.definition_version || workflowSignature(definition) !== row.definition_signature) throw new ApiError(403, 'workflow_forbidden')
    await startScope(definition)
  }
  const visible = async (row: Record<string, any>) => {
    try { await authorize(row); return true } catch (error) { if (error instanceof ApiError && error.status === 403) return false; throw error }
  }
  return {
    startScope,
    async catalog() {
      const available = []
      for (const definition of definitions.values()) {
        try { await startScope(definition); available.push(definition) } catch (error) { if (!(error instanceof ApiError) || error.status !== 403) throw error }
      }
      return available
    },
    async counts() {
      await readScope()
      const rows = await env.DB.prepare('SELECT definition_name,definition_version,definition_signature,status,count(*) AS n FROM workflow_runs WHERE organization_id=? GROUP BY definition_name,definition_version,definition_signature,status').bind(organizationId).all<Record<string, any>>()
      const counts: Record<string, number> = {}
      for (const row of rows.results) if (await visible(row)) counts[row.status] = (counts[row.status] ?? 0) + row.n
      return counts
    },
    async list(status?: string, browser = false) {
      await readScope()
      const rows = await env.DB.prepare(`SELECT id,definition_name,definition_version,definition_signature,status,last_error_code,created_at,updated_at${browser ? ',actor_type' : ''} FROM workflow_runs WHERE organization_id=?${status ? ' AND status=?' : ''} ORDER BY created_at DESC,id LIMIT 100`).bind(organizationId, ...(status ? [status] : [])).all<Record<string, any>>()
      const data = []
      for (const row of rows.results) if (await visible(row)) { const { definition_signature, ...item } = row; data.push(item) }
      return data
    },
    async detail(id: string, browser = false): Promise<Record<string, any>> {
      const scope = await readScope()
      const row = await lookupWorkflow(env, id, organizationId)
      await authorize(row)
      const { result_json, definition_signature, ...rest } = row
      let result = result_json ? JSON.parse(result_json) : null
      if (result) {
        try {
          const kernel = kernelFor(config)
          const definition = definitions.get(row.definition_name)
          if (!definition || definition.version !== row.definition_version || workflowSignature(definition) !== definition_signature) throw new ApiError(403, 'workflow_forbidden')
          for (const step of definition.steps!) {
            const entities = [...('entity' in step.operation.permission ? [step.operation.permission.entity] : []), ...(step.operation.additionalPermissions ?? []).map(grant => grant.entity)]
            if (entities.some(entity => !kernel.can(scope, entity, 'read'))) throw new ApiError(403, 'policy_violation')
          }
          const atomicSteps = definition.steps!.filter(step => step.kind !== 'external')
          const required = needsPolicyReceipt(kernel)
          if (required && !atomicSteps.length) throw new ApiError(403, 'policy_violation')
          for (const step of atomicSteps) {
            const rows = result[step.id]?.__workbase_policy?.rows
            // Historical/read-only results have no row evidence; only unrestricted
            // read policies can authorize those opaque snapshots.
            if (!rows?.length) { if (required || rows) throw new ApiError(403, 'policy_violation'); continue }
            await authorizeReceiptRows(kernel, scope, new D1AtomicReader(env.DB), rows, true)
          }
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 403) throw error
          result = null
        }
      }
      // Private effect receipts may also survive crash recovery in old runs.
      if (result) result = Object.fromEntries(Object.entries(result).map(([key, value]) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return [key, value]
        const { __workbase_policy, ...publicValue } = value as Record<string, unknown>
        return [key, publicValue]
      }))
      const steps = await env.DB.prepare(`SELECT step_id,status,attempts,compensation_attempts,next_attempt_at,last_error_code${browser ? ',deadline_at,compensation_deadline_at' : ''} FROM workflow_steps WHERE run_id=? ORDER BY position`).bind(id).all()
      return { ...rest, result, steps: steps.results }
    },
  }
}
async function lookupWorkflow(env: RuntimeEnv, id: string, organizationId: string) {
  const row = await env.DB.prepare('SELECT id,organization_id,definition_name,definition_version,definition_signature,status,result_json,last_error_code,created_at,updated_at FROM workflow_runs WHERE id=? AND organization_id=?').bind(id, organizationId).first<Record<string, any>>()
  if (!row) throw new ApiError(403, 'workflow_forbidden')
  return row
}
