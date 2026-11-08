import { Label } from '@workbasehq/ui/components/ui/label'
import { NativeSelect } from '@workbasehq/ui/components/ui/native-select'
import { useId, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ActionDialog, MutationSubmitButton, MutationErrorAlert, useMutationSubmit, RegistryForm, ResponsiveList, type ListColumn } from '@workbasehq/ui'
import { ApiError } from './api/client'
import { isWorkflowTerminal, useWorkflowAccess, useWorkflowAction, useWorkflowPolling, workflowClient, workflowKey, workflowSchemaOptions, workflowStatuses, type WorkflowFilter, type WorkflowRun, type WorkflowStep, type WorkflowDefinition } from './api/workflows'
import { redactWorkflowResult } from './api/workflow-result'
import { Failure, Loading, Page, QueryError } from './screens'

function useRunLabels() {
  const { t, i18n } = useTranslation()
  return { t, status: (value: string) => t(`workflowStatus_${value}`, { defaultValue: t('workflowUnknown') }), date: (value?: string | number | null) => value != null && Number.isFinite(new Date(value).getTime()) ? new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : t('unavailable') }
}
function ActionError({ error }: { error: Error | null }) {
  const { t } = useTranslation()
  if (!error) return null
  return <MutationErrorAlert isError error={error} fallbackMessage={t(error instanceof ApiError && error.status === 409 ? 'workflowConflict' : error instanceof ApiError && [400, 422].includes(error.status) ? 'write_validation_error' : 'identityFailed')} />
}
function Denied() { const { t } = useTranslation(); return <><p role="alert">{t('identityDenied')}</p><Failure kind="forbidden" /></> }
export function WorkflowList({ orgId, filter }: { orgId: string; filter: WorkflowFilter }) {
  const filterId = useId(); const { t, date, status } = useRunLabels(); const access = useWorkflowAccess(orgId); const navigate = useNavigate()
  const rows = useQuery({ queryKey: [...workflowKey(orgId, access.scope.data?.role), 'list', filter], queryFn: () => workflowClient.list(orgId, filter), enabled: access.canRead, staleTime: 0 })
  if (access.denied) return <Denied />
  if (access.scope.error || access.caps.error || access.read.error || rows.error) return <QueryError error={(access.scope.error ?? access.caps.error ?? access.read.error ?? rows.error)!} />
  if (!access.canRead || !rows.data || !access.caps.data) return <Loading />
  const columns: ListColumn<WorkflowRun>[] = [
    { key: 'name', label: t('field_name'), render: row => <Link to="/o/$orgId/settings/workflows/$id" params={{ orgId, id: row.id }}>{row.definition_name}<span className="c5-run-id">{row.id}</span></Link> },
    { key: 'status', label: t('status'), render: row => status(row.status) }, { key: 'started', label: t('workflowStarted'), render: row => date(row.created_at) },
    { key: 'updated', label: t('field_updated_at'), render: row => date(row.updated_at) }, { key: 'deadline', label: t('workflowDeadline'), render: row => date(row.deadline_at) },
  ]
  return <Page title={t('workflowRuns')}><div className="c5-screen">
    {Object.values(access.actions).some(actions => actions.includes('start')) && <Link to="/o/$orgId/settings/workflows/new" params={{ orgId }}>{t('workflowStart')}</Link>}
    <div className="c2-controls"><Label htmlFor={filterId}>{t('workflowFilter')}</Label><NativeSelect id={filterId} value={filter} onChange={event => void navigate({ to: '/o/$orgId/settings/workflows', params: { orgId }, search: { status: event.target.value as WorkflowFilter } })}><option value="all">{t('all')}</option>{workflowStatuses.map(value => <option value={value} key={value}>{status(value)}</option>)}</NativeSelect></div>
    <p>{t('workflowListLimit')}</p><ResponsiveList label={t('workflowRuns')} data={rows.data.data} columns={columns} rowKey={row => row.id} />{!rows.data.data.length && <p>{t('noResults')}</p>}
  </div></Page>
}
function RunAction({ orgId, run, action, submissionKey, close }: { orgId: string; run: WorkflowRun; action: 'resume' | 'cancel'; submissionKey: string; close: () => void }) {
  const submit = useMutationSubmit(); const { t } = useTranslation(); const authorize = useWorkflowAction(orgId, run.definition_name, action); const client = useQueryClient()
  const mutation = useMutation({ mutationFn: () => authorize(() => workflowClient.action(orgId, run.id, action, submissionKey)), onSuccess: async () => { await client.invalidateQueries({ queryKey: ['workflow-runs', orgId] }); close() } })
  return <form onSubmit={event => { event.preventDefault(); void submit(() => mutation.mutateAsync()) }}><ActionError error={mutation.error} /><MutationSubmitButton type="submit" pending={mutation.isPending}>{t(action === 'resume' ? 'workflowResume' : 'workflowCancel')}</MutationSubmitButton></form>
}
export function WorkflowDetail({ orgId, id }: { orgId: string; id: string }) {
  const { t, date, status } = useRunLabels(); const access = useWorkflowAccess(orgId)
  const run = useQuery({ queryKey: [...workflowKey(orgId, access.scope.data?.role), 'detail', id], queryFn: () => workflowClient.detail(orgId, id), enabled: access.canRead, refetchOnWindowFocus: false, refetchOnReconnect: false, staleTime: 0 })
  // Only the detail component owns this timer. It is destroyed on route navigation,
  // permission loss, an error, or a terminal response; never a background cache timer.
  useWorkflowPolling(access.canRead && !run.error ? run.data?.status : undefined, () => { if (!run.isFetching) void run.refetch() })
  if (access.denied) return <Denied />
  if (access.scope.error || access.caps.error || access.read.error || run.error) return <QueryError error={(access.scope.error ?? access.caps.error ?? access.read.error ?? run.error)!} />
  if (!access.canRead || !run.data || !access.caps.data) return <Loading />
  const row = run.data; const grants = access.actions[row.definition_name] ?? []
  const columns: ListColumn<WorkflowStep>[] = [
    { key: 'step', label: t('workflowStep'), render: step => step.step_id }, { key: 'state', label: t('status'), render: step => status(step.status) },
    { key: 'attempts', label: t('workflowAttempts'), render: step => new Intl.NumberFormat().format(step.attempts) },
    { key: 'deadline', label: t('workflowDeadline'), render: step => date(step.deadline_at) }, { key: 'undoDeadline', label: t('workflowUndoDeadline'), render: step => date(step.compensation_deadline_at) },
    { key: 'retry', label: t('workflowNextAttempt'), render: step => date(step.next_attempt_at || null) }, { key: 'error', label: t('workflowError'), render: step => step.last_error_code ? <code>{step.last_error_code}</code> : t('nullValue') },
  ]
  return <Page title={t('workflowRun')}><div className="c5-screen"><Link to="/o/$orgId/settings/workflows" params={{ orgId }} search={{ status: 'needs_attention' }}>{t('backToList')}</Link>
    <dl className="c2-detail">{[[t('field_name'), row.definition_name], [t('field_id'), row.id], [t('status'), <span data-testid="run-status">{status(row.status)}</span>], [t('workflowStarted'), date(row.created_at)], [t('field_updated_at'), date(row.updated_at)], [t('workflowDeadline'), date(row.deadline_at)], [t('workflowError'), row.last_error_code ?? t('nullValue')]].map(([label, value], index) => <div key={index}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <div className="c5-actions">{(['resume', 'cancel'] as const).filter(action => grants.includes(action)).map(action => {
      const label = t(action === 'resume' ? 'workflowResume' : 'workflowCancel')
      const disabledReason = isWorkflowTerminal(row.status) ? t('workflowTerminal') : action === 'resume' && row.status !== 'needs_attention' ? t('workflowNotPaused') : undefined
      return <ActionDialog key={action} trigger={label} title={label} description={t(action === 'resume' ? 'workflowResumeConfirm' : 'workflowCancelConfirm')} cancelLabel={t('cancel')} destructive disabledReason={disabledReason}>{({ close, submissionKey }) => <RunAction orgId={orgId} run={row} action={action} submissionKey={submissionKey} close={close} />}</ActionDialog>
    })}</div>
    <h2>{t('workflowResult')}</h2><SafeResult result={row.result} />
    <h2>{t('workflowSteps')}</h2><ResponsiveList label={t('workflowSteps')} data={row.steps ?? []} columns={columns} rowKey={step => step.step_id} />
  </div></Page>
}
function SafeResult({ result }: { result: unknown }) { const { t } = useTranslation(); return result == null ? <p>{t('nullValue')}</p> : <pre>{JSON.stringify(redactWorkflowResult(result, t('redactedValue')), null, 2)}</pre> }
function StartForm({ orgId, definition, submissionKey }: { orgId: string; definition: WorkflowDefinition; submissionKey: string }) {
  const { t } = useTranslation(); const navigate = useNavigate(); const authorize = useWorkflowAction(orgId, definition.name, 'start'); const client = useQueryClient()
  const mutation = useMutation({ mutationFn: (body: Record<string, unknown>) => authorize(() => workflowClient.start(orgId, definition.name, body, submissionKey)), onSuccess: async result => { await client.invalidateQueries({ queryKey: ['workflow-runs', orgId] }); await navigate({ to: '/o/$orgId/settings/workflows/$id', params: { orgId, id: result.id } }) } })
  return <><ActionError error={mutation.error} /><RegistryForm optionLabel={value => t(`value_${value}`, { defaultValue: value })} schema={definition.inputSchema} label={name => t(`workflowField_${name}`, { defaultValue: t(`command_${name}`, { defaultValue: name }) })} submitLabel={t('workflowStart')} invalidLabel={t('invalidField')} pending={mutation.isPending} serverInvalid={mutation.error instanceof ApiError && [400, 422].includes(mutation.error.status)} onSubmit={body => mutation.mutateAsync(body)} /></>
}
function SelectedWorkflow({ orgId, definition }: { orgId: string; definition: WorkflowDefinition }) {
  const [submissionKey] = useState(() => crypto.randomUUID())
  return <StartForm orgId={orgId} definition={definition} submissionKey={submissionKey} />
}
export function WorkflowStart({ orgId }: { orgId: string }) {
  const definitionId = useId(); const { t } = useTranslation(); const access = useWorkflowAccess(orgId); const schema = useQuery(workflowSchemaOptions(orgId)); const [selected, setSelected] = useState('')
  if (access.denied) return <Denied />
  if (access.scope.error || access.caps.error || schema.error) return <QueryError error={(access.scope.error ?? access.caps.error ?? schema.error)!} />
  if (!access.scope.data || !access.caps.data || !schema.data) return <Loading />
  const definitions = schema.data.workflows.filter(definition => access.actions[definition.name]?.includes('start'))
  if (!definitions.length) return <Failure kind="forbidden" />
  const definition = definitions.find(item => item.name === selected) ?? definitions[0]
  return <Page title={t('workflowStart')}><div className="c5-screen c1-card"><Label htmlFor={definitionId}>{t('workflowDefinition')}</Label><NativeSelect id={definitionId} value={definition.name} onChange={event => setSelected(event.target.value)}>{definitions.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</NativeSelect><SelectedWorkflow key={definition.name} orgId={orgId} definition={definition} /></div></Page>
}
