import { Badge } from '@workbasehq/ui/components/ui/badge'
import { Label } from '@workbasehq/ui/components/ui/label'
import { Input } from '@workbasehq/ui/components/ui/input'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button, ResponsiveList, type ListColumn } from '@workbasehq/ui'
import { type ReadQuery, type Result } from '@workbasehq/console-generated/read'
import { api, ApiError } from './api/client'
import { isCredentialShaped } from './api/redact'
import { auditPath, type AuditEvent, type AuditPage } from './api/workflows'
import { Loading, Page, QueryError } from './screens'
import { AuditDiff } from './audit-diff'
import { useCapabilities } from './api/queries'
import { useRuntimeModel } from './api/runtime-model'
import { useAuditLabels } from './audit-labels'

export function AuditScreen({ orgId }: { orgId: string }) {
  const { t, i18n } = useTranslation(); const caps = useCapabilities(orgId)
  const canAudit = !caps.error && caps.data?.resources?.['audit.read'] === true
  const [draft, setDraft] = useState<Record<string, string>>({}); const [filters, setFilters] = useState<Record<string, string>>({}); const [cursors, setCursors] = useState<string[]>([])
  const rows = useQuery({ queryKey: ['audit-events', orgId, caps.data?.organization?.role, filters, cursors.at(-1)], queryFn: () => api<AuditPage>(auditPath(filters, cursors.at(-1)), { orgId }), enabled: canAudit, retry: false })
  const runtime = useRuntimeModel(orgId)
  const model = runtime.error ? undefined : runtime.data?.model
  const referenceLabel = useAuditLabels(model, caps.data, orgId, canAudit && !rows.error ? rows.data?.data ?? [] : [], (query: ReadQuery) => api<Result>('/query', { orgId, method: 'POST', body: query }), i18n.language, t)
  if (caps.error || rows.error || runtime.error) return <QueryError error={(caps.error ?? rows.error ?? runtime.error)!} />
  if (caps.data && !canAudit) return <QueryError error={new ApiError(403, 'permission_denied')} />
  if (!canAudit || !rows.data) return <Loading />
  const display = (value: string | number | null | undefined, context: 'value' | 'identifier' = 'value') => typeof value === 'string' && isCredentialShaped(value, context) ? t('redactedValue') : value ?? t('unavailable')
  const resourceLabel = (entity: string) => {
    const configured = model?.ui?.navigation?.items.find(item => item.entity === entity && !item.view)?.label
    return display(t(configured ?? `entity_${entity}`, { defaultValue: configured ?? entity }))
  }
  const columns: ListColumn<AuditEvent>[] = [
    { key: 'time', label: t('auditTime'), render: row => isCredentialShaped(row.occurred_at) ? t('redactedValue') : new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(row.occurred_at)) },
    { key: 'actor', label: t('auditActor'), render: row => <>{t(`auditActor_${row.actor.type}`, { defaultValue: t('workflowUnknown') })}: {row.actor.label || display(row.actor.id, 'identifier')}</> },
    { key: 'action', label: t('auditAction'), render: row => {
      const verb = row.operation.split('.').at(-1)!
      const known = ['created', 'updated', 'deleted'].includes(verb)
      return <Badge variant="outline" className={known ? `c5-audit-op-${verb}` : undefined}>{known ? t(`auditOp_${verb}`) : display(row.operation)}</Badge>
    } },
    { key: 'resource', label: t('auditResource'), render: row => <>{resourceLabel(row.entity)} / {display(row.entity_id, 'identifier')}</> },
    { key: 'details', label: t('auditDetails'), render: row => <details><AuditDiff event={row} fields={model?.entities[row.entity]?.fields} referenceLabel={(field, id) => referenceLabel(row.entity, field, id)} fieldLabel={field => model?.entities[row.entity]?.fields[field] ? t(`field_${field}`, { defaultValue: '' }) || undefined : undefined} /><details className="c5-audit-technical"><summary>{t('auditTechnicalDetails')}</summary><dl className="c5-audit-details"><dt>{t('auditEventId')}</dt><dd>{display(row.event_id)}</dd><dt>{t('auditCorrelation')}</dt><dd>{display(row.correlation_id)}</dd><dt>{t('auditSchema')}</dt><dd>{display(row.schema_version)}</dd></dl></details></details> },
  ]
  return <Page title={t('auditLog')}><div className="c5-screen c5-audit-screen"><p>{t('auditDelivered')}</p>
    <form className="c2-controls" onSubmit={event => { event.preventDefault(); setFilters(Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, value && ['from', 'to'].includes(key) ? new Date(value).toISOString() : value]))); setCursors([]) }}>
      {(['entity', 'entity_id', 'from', 'to'] as const).map(field => <Label key={field}>{t(`auditFilter_${field}`)}<Input type={['from', 'to'].includes(field) ? 'datetime-local' : 'text'} value={draft[field] ?? ''} onChange={event => setDraft({ ...draft, [field]: event.target.value })} /></Label>)}<Button type="submit">{t('auditApply')}</Button>
    </form>
    <ResponsiveList label={t('auditLog')} data={rows.data.data} columns={columns} rowKey={row => row.event_id} />{!rows.data.data.length && <p>{t('noResults')}</p>}
    <nav className="c2-pagination" aria-label={t('auditPagination')}><Button variant="outline" disabled={!cursors.length || rows.isFetching} onClick={() => setCursors(current => current.slice(0, -1))}>{t('previousPage')}</Button><Button variant="outline" disabled={!rows.data.next_cursor || rows.isFetching} onClick={() => setCursors(current => [...current, rows.data!.next_cursor!])}>{t('nextPage')}</Button></nav>
  </div></Page>
}
