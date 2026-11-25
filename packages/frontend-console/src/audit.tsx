import { Badge } from '@workbasehq/ui/components/ui/badge'
import { Label } from '@workbasehq/ui/components/ui/label'
import { Input } from '@workbasehq/ui/components/ui/input'
import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button, DataTable, ListFilterPanel, ListPageComposition, type ServerColumn } from '@workbasehq/ui'
import { ListFilter, ScrollText } from 'lucide-react'
import { type ReadQuery, type Result } from '@workbasehq/console-generated/read'
import { api, ApiError } from './api/client'
import { isCredentialShaped } from './api/redact'
import { auditPath, type AuditEvent, type AuditPage } from './api/workflows'
import { Loading, Page, QueryError } from './screens'
import { AuditDiff } from './audit-diff'
import { useCapabilities } from './api/queries'
import { useRuntimeModel } from './api/runtime-model'
import { useAuditLabels } from './audit-labels'

const filterFields = ['entity', 'entity_id', 'from', 'to'] as const
const dateField = (field: string) => field === 'from' || field === 'to'

export function AuditScreen({ orgId }: { orgId: string }) {
  const { t, i18n } = useTranslation(); const caps = useCapabilities(orgId)
  const canAudit = !caps.error && caps.data?.resources?.['audit.read'] === true
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [cursors, setCursors] = useState<string[]>([])
  const [panelOpen, setPanelOpen] = useState(false)
  const panelId = useId()
  // Only confirmed filters form the request. Retain local input values for Cancel.
  const applied = Object.fromEntries(Object.entries(filters).map(([key, value]) => [key, value && dateField(key) ? new Date(value).toISOString() : value]))
  const rows = useQuery({ queryKey: ['audit-events', orgId, caps.data?.organization?.role, applied, cursors.at(-1)], queryFn: () => api<AuditPage>(auditPath(applied, cursors.at(-1)), { orgId }), enabled: canAudit, retry: false })
  const runtime = useRuntimeModel(orgId)
  const model = runtime.error ? undefined : runtime.data?.model
  const failure = rows.error ?? runtime.error
  const referenceLabel = useAuditLabels(model, caps.data, orgId, canAudit && !failure ? rows.data?.data ?? [] : [], (query: ReadQuery) => api<Result>('/query', { orgId, method: 'POST', body: query }), i18n.language, t)
  if (caps.error) return <QueryError error={caps.error} />
  if ((caps.data && !canAudit) || [rows.error, runtime.error].some(error => error instanceof ApiError && error.status === 403)) return <QueryError error={new ApiError(403, 'permission_denied')} />
  if (!canAudit) return <Loading />
  const loading = rows.isPending || rows.isFetching || runtime.isFetching
  const hasFilters = Object.values(filters).some(Boolean)
  const clear = () => { setDraft({}); setFilters({}); setCursors([]) }
  const invalid = filterFields.some(field => dateField(field) && draft[field] && !Number.isFinite(Date.parse(draft[field])))
  const display = (value: string | number | null | undefined, context: 'value' | 'identifier' = 'value') => typeof value === 'string' && isCredentialShaped(value, context) ? t('redactedValue') : value || value === 0 ? value : t('unavailable')
  const resourceLabel = (entity: string) => {
    const configured = model?.ui?.navigation?.items.find(item => item.entity === entity && !item.view)?.label
    return display(t(configured ?? `entity_${entity}`, { defaultValue: configured ?? entity }))
  }
  const columns: ServerColumn<AuditEvent>[] = [
    { id: 'time', label: t('auditTime'), align: 'center', wrap: true, cell: row => !row.occurred_at ? t('unavailable') : isCredentialShaped(row.occurred_at) ? t('redactedValue') : Number.isFinite(Date.parse(row.occurred_at)) ? new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(row.occurred_at)) : t('unavailable') },
    { id: 'actor', label: t('auditActor'), wrap: true, cell: row => row.actor ? <>{row.actor.type && <>{t(`auditActor_${row.actor.type}`, { defaultValue: t('workflowUnknown') })}: </>}{display(row.actor.label || row.actor.id, row.actor.label ? 'value' : 'identifier')}</> : t('unavailable') },
    { id: 'action', label: t('auditAction'), wrap: true, cell: row => {
      const verb = row.operation?.split('.').at(-1) ?? ''
      const known = ['created', 'updated', 'deleted'].includes(verb)
      return <Badge variant="outline" className={known ? `c5-audit-op-${verb}` : undefined}>{known ? t(`auditOp_${verb}`) : display(row.operation)}</Badge>
    } },
    { id: 'resource', label: t('auditResource'), wrap: true, cell: row => <>{row.entity ? resourceLabel(row.entity) : t('unavailable')} / {display(row.entity_id, 'identifier')}</> },
    { id: 'details', label: t('auditDetails'), wrap: true, cell: row => <details><AuditDiff event={row} timeZone={model?.timeZone} fields={model?.entities[row.entity]?.fields} referenceLabel={(field, id) => referenceLabel(row.entity, field, id)} fieldLabel={field => model?.entities[row.entity]?.fields[field] ? t(`field_${field}`, { defaultValue: '' }) || undefined : undefined} /><details className="c5-audit-technical"><summary>{t('auditTechnicalDetails')}</summary><dl className="c5-audit-details"><dt>{t('auditEventId')}</dt><dd>{display(row.event_id)}</dd><dt>{t('auditCorrelation')}</dt><dd>{display(row.correlation_id)}</dd><dt>{t('auditSchema')}</dt><dd>{display(row.schema_version)}</dd></dl></details></details> },
  ]
  const continuation = !!rows.data?.next_cursor
  const emptyContent = <div className="flex min-h-[300px] flex-col items-center justify-center px-6 py-[68px] text-center">
    <span className="mb-5 flex size-14 items-center justify-center rounded-[18px] border border-border bg-muted text-primary" aria-hidden="true"><ScrollText className="size-6" /></span>
    <h3 className="mb-3 text-lg font-normal text-foreground">{t(continuation ? 'auditS5EmptyPage' : hasFilters ? 'auditS5NoMatches' : 'auditS5Empty')}</h3>
    <p className="mb-[22px] max-w-[390px] text-xs leading-[1.7] text-muted-foreground">{t(continuation ? 'auditS5ContinueHelp' : hasFilters ? 'auditS5FilterHelp' : 'auditS5EmptyHelp')}</p>
    {!continuation && hasFilters && <Button variant="outline" onClick={clear}>{t('clearAllFilters')}</Button>}
  </div>
  return <Page title={t('auditLog')}><div className="c5-audit-screen space-y-4 min-w-0">
    <p className="text-sm text-muted-foreground">{t('auditDelivered')}</p>
    <ListPageComposition toolbar={<><Button variant="outline" aria-expanded={panelOpen} aria-controls={panelId} onClick={() => setPanelOpen(!panelOpen)}><ListFilter className="size-4" aria-hidden="true" />{t('sortAndFilter')}</Button>{hasFilters && <span className="text-xs text-muted-foreground">{t('auditS5AppliedFilters', { count: Object.values(filters).filter(Boolean).length })}</span>}</>}
      panel={panelOpen && <div id={panelId}><ListFilterPanel label={t('sortAndFilter')} invalid={!!invalid} hint={t('filterDraftHint')} applyLabel={t('auditApply')} cancelLabel={t('cancel')} clearLabel={t('clearAllFilters')} onCancel={() => { setDraft(filters); setPanelOpen(false) }} onClear={() => setDraft({})} onApply={() => { setFilters({ ...draft }); setCursors([]); setPanelOpen(false) }}>
        {filterFields.map(field => <div key={field} className="grid min-w-0 gap-2"><Label htmlFor={`${panelId}-${field}`}>{t(`auditFilter_${field}`)}</Label><Input id={`${panelId}-${field}`} className="min-w-0 w-full" type={dateField(field) ? 'datetime-local' : 'text'} value={draft[field] ?? ''} onChange={event => setDraft({ ...draft, [field]: event.target.value })} /></div>)}
      </ListFilterPanel></div>}
      footer={<nav className="flex flex-wrap justify-end gap-2 p-3" aria-label={t('auditPagination')}><Button variant="outline" disabled={!cursors.length || loading || !!failure} onClick={() => setCursors(current => current.slice(0, -1))}>{t('previousPage')}</Button><Button variant="outline" disabled={!continuation || loading || !!failure} onClick={() => setCursors(current => [...current, rows.data!.next_cursor!])}>{t('nextPage')}</Button></nav>}>
      {loading && <p role="status" className="sr-only">{t('loading')}</p>}
      <DataTable listV2 compact scrollOnNarrow hideFooter searchAvailable={false}
        rows={failure ? [] : (rows.data?.data ?? []).map(row => ({ ...row, id: row.event_id }))} columns={columns}
        state={{ search: '', sort: null, limit: 25 }} onStateChange={() => {}} page={cursors.length} onPage={() => {}} onRowClick={undefined!}
        label={t('auditLog')} isFetching={loading} emptyContent={emptyContent}
        error={failure ? new Error(t('auditS5RequestFailed')) : null} onRetry={() => { void (runtime.error ? runtime.refetch() : rows.refetch()) }}
        labels={{ error: t('auditS5RequestFailed'), errorDescription: t('auditS5RetryHelp'), retry: t('listRetry'), search: t('search'), clearSearch: t('clearSearch'), noResults: t('auditS5Empty'), sort: column => t('sortColumn', { column }), previous: t('previousPage'), next: t('nextPage'), pageSize: t('rowsPerPage'), range: () => '', scrollRegion: t('listScrollRegion'), scrollHint: t('listScrollHint') }} />
    </ListPageComposition>
  </div></Page>
}
