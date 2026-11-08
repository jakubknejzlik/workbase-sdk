import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { runtimeModelOptions } from './runtime-model'
import { api, ApiError } from './client'
import { fetchCapabilities, organizationOptions, useCapabilities, useOrganization } from './queries'

// Keep the runtime vocabulary (execution/workflow.ts). success/error are defensive
// wire aliases: an older/future worker must not leave a terminal screen polling.
export const workflowStatuses = ['pending', 'running', 'waiting_external', 'completed', 'failed', 'compensating', 'compensated', 'needs_attention', 'cancelled', 'success', 'error'] as const
export type WorkflowFilter = typeof workflowStatuses[number] | 'all'
export const isWorkflowTerminal = (status?: string) => ['completed', 'success', 'failed', 'cancelled', 'compensated', 'error'].includes(status ?? '')
export const workflowFilter = (value: unknown): WorkflowFilter => value === 'all' || workflowStatuses.includes(value as typeof workflowStatuses[number]) ? value as WorkflowFilter : 'needs_attention'
export const workflowListPath = (filter: WorkflowFilter) => filter === 'all' ? '/workflows' : `/workflows?status=${filter}`
export interface WorkflowStep { step_id: string; status: string; attempts: number; compensation_attempts: number; next_attempt_at?: number; deadline_at?: number | null; compensation_deadline_at?: number | null; last_error_code?: string | null }
export interface WorkflowRun { id: string; definition_name: string; status: string; created_at: string; updated_at: string; deadline_at?: number | null; last_error_code?: string | null; result?: unknown; steps?: WorkflowStep[] }
export interface WorkflowDefinition { name: string; version: string; inputSchema: Record<string, any> }
export interface WorkflowSchema { instance: string; revision: number; workflows: WorkflowDefinition[] }
export interface AuditEvent { event_id: string; occurred_at: string; actor: { type: string; id: string; label?: string }; operation: string; entity: string; entity_id: string; correlation_id?: string; schema_version?: number; changes: Record<string, { before?: unknown; after?: unknown }>; details?: Record<string, unknown> }
export interface AuditPage { data: AuditEvent[]; next_cursor: string | null }
export const workflowRoot = (id: string) => `/workflows/${encodeURIComponent(id)}`
export const workflowClient = {
  list: (orgId: string, filter: WorkflowFilter) => api<{ data: WorkflowRun[] }>(workflowListPath(filter), { orgId }),
  detail: (orgId: string, id: string) => api<WorkflowRun>(workflowRoot(id), { orgId }),
  action: (orgId: string, id: string, action: 'resume' | 'cancel', key: string) => api(workflowRoot(id) + '/' + action, { orgId, method: 'POST', idempotencyKey: key }),
  start: (orgId: string, name: string, input: Record<string, unknown>, key: string) => api<{ id: string }>('/workflows/' + name.split('/').map(encodeURIComponent).join('/'), { orgId, method: 'POST', body: input, idempotencyKey: key }),
}
export const workflowKey = (orgId: string, role?: string) => ['workflow-runs', orgId, role] as const
export const workflowSchemaOptions = (orgId: string) => ({ ...runtimeModelOptions(orgId), select: (document: import('./runtime-model').RuntimeConsole): WorkflowSchema => document.model })
export function auditPath(filters: Record<string, string>, cursor?: string) {
  const query = new URLSearchParams({ limit: '25' })
  for (const field of ['entity', 'entity_id', 'from', 'to']) if (filters[field]) query.set(field, filters[field])
  if (cursor) query.set('cursor', cursor)
  return '/audit/events?' + query
}
const deniedKey = (orgId: string) => ['workflow-denied', orgId] as const
/** Workflow actions retain their live scope/read checks. Audit screens use the
 * audit.read capability directly and handle denial from their real page request. */
export function useWorkflowAccess(orgId: string) {
  const scope = useOrganization(orgId); const caps = useCapabilities(orgId); const client = useQueryClient()
  const role = scope.data?.role
  const currentGrants = !!role && caps.data?.organization?.role === role
  useEffect(() => { if (role && caps.data && !currentGrants) void client.invalidateQueries({ queryKey: ['capabilities', orgId] }) }, [role, caps.data, currentGrants, client, orgId])
  const denied = useQuery({ queryKey: deniedKey(orgId), queryFn: () => false, initialData: false, enabled: false }).data
  const enabled = !!orgId && !!scope.data && !scope.error
  const read = useQuery({ queryKey: ['workflow-authority', orgId, scope.data?.role], queryFn: () => workflowClient.list(orgId, 'needs_attention'), enabled: enabled && !denied, staleTime: 0, refetchOnWindowFocus: true })
  return { scope, caps, actions: currentGrants ? caps.data?.workflows ?? {} : {}, read, denied, canRead: !denied && enabled && !!caps.data && !caps.error && !!read.data && !read.error }
}
/** Like C4 useIdentityAction: live identity + server-computed grants immediately
 * before sending. 403 invalidates the whole workflow surface until a reload. */
export function useWorkflowAction(orgId: string, definition: string, action: 'start' | 'resume' | 'cancel') {
  const client = useQueryClient()
  return async <T,>(send: () => Promise<T>) => {
    try {
      const scope = await client.fetchQuery({ ...organizationOptions(orgId), staleTime: 0 })
      const previous = client.getQueryData<{ revision: number }>(['capabilities', orgId])
      const caps = await client.fetchQuery({ queryKey: ['capabilities', orgId], queryFn: () => fetchCapabilities(client, orgId), staleTime: 0 })
      if (previous && previous.revision !== caps.revision) throw new ApiError(409, 'schema_revision_mismatch')
      if (!caps.workflows?.[definition]?.includes(action) || (action !== 'start' && scope.operations && !scope.operations.includes(`workflows.${action}`))) throw new ApiError(403, 'permission_denied')
      return await send()
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        client.setQueryData(deniedKey(orgId), true)
        void Promise.all([client.invalidateQueries({ queryKey: ['me'] }), client.invalidateQueries({ queryKey: ['organization', orgId] }), client.invalidateQueries({ queryKey: ['capabilities', orgId] })])
      }
      throw error
    }
  }
}
/** Effect lifecycle extracted for deterministic timer/visibility tests. */
export function workflowPoller(status: string | undefined, refresh: () => unknown, doc: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>) {
  if (!status || isWorkflowTerminal(status)) return () => {}
  let timer: ReturnType<typeof setInterval> | undefined
  const stop = () => { if (timer !== undefined) clearInterval(timer); timer = undefined }
  const start = () => { stop(); if (doc.visibilityState === 'visible') timer = setInterval(refresh, 3000) }
  const visibility = () => { stop(); if (doc.visibilityState === 'visible') { void refresh(); start() } }
  start(); doc.addEventListener('visibilitychange', visibility)
  return () => { stop(); doc.removeEventListener('visibilitychange', visibility) }
}
export function useWorkflowPolling(status: string | undefined, refresh: () => unknown) {
  const callback = useRef(refresh); callback.current = refresh
  useEffect(() => workflowPoller(status, () => callback.current(), document), [status])
}
