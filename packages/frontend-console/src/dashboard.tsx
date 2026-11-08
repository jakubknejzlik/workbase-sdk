import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link } from '@tanstack/react-router'
import { Card, CardHeader, CardTitle, CardContent } from '@workbasehq/ui/components/ui/card'
import { Skeleton } from '@workbasehq/ui/components/ui/skeleton'
import { formatFieldValue, recordLabel, type Model, type Capabilities } from '@workbasehq/console-generated/read'
import { signedValue } from '@workbasehq/console-generated/screens'
import { DetailCards } from '../../console-generated/src/detail-layout'
import { shortRecordId } from '../../console-generated/src/labels'
import type { ConsolePage, ConsolePageResult, ConsoleWidgetResult } from '../../plugins/console/src/contract'
import { api } from './api/client'
import { useRuntimeModel } from './api/runtime-model'
import { Page } from './screens'

export function WidgetPage({ orgId, page }: { orgId: string; page: ConsolePage }) {
  const { t } = useTranslation()
  const runtime = useRuntimeModel(orgId)
  const model = runtime.error ? undefined : runtime.data?.model
  const caps = runtime.error ? undefined : runtime.data?.capabilities
  const result = useQuery({ queryKey: ['console-page', orgId, page.id, caps],
    queryFn: () => api<ConsolePageResult>(`/o/${encodeURIComponent(orgId)}/console-pages/${encodeURIComponent(page.id)}`), enabled: !!model && !!caps, refetchOnWindowFocus: true })
  return <Page title={t(page.label)}><div className="space-y-6"><WidgetCards orgId={orgId} page={page} result={result.data} pending={result.isPending} error={result.error ?? runtime.error} model={model} caps={caps} /></div></Page>
}

/** All values, including reference labels, arrive in the single page response. */
export function WidgetCards({ orgId, page, result, pending, error, model, caps }: {
  orgId: string; page: ConsolePage; result?: ConsolePageResult; pending: boolean; error: Error | null; model?: Model; caps?: Capabilities
}) {
  const { t, i18n } = useTranslation()
  const value = (widget: ConsoleWidgetResult, row: Record<string, any>, field: string) => {
    if (field === 'id') return <span title={String(row.id)}>{shortRecordId(row.id)}</span>
    const configured = page.widgets?.find(item => item.id === widget.id)
    const entity = configured?.query.entity
    const spec = entity ? model?.entities[entity]?.fields[field] : undefined
    const label = row.__labels?.[field]
    if (label) {
      if (label.status === 'empty') return '—'
      if (label.status !== 'ok' || !model || !caps) return t('unavailableRecord')
      return <Link to="/o/$orgId/e/$entity/$id" params={{ orgId, entity: label.entity, id: label.row.id }}>{recordLabel(model, label.entity, label.row, caps, i18n.language, t)}</Link>
    }
    if (spec?.type === 'ref') return t('unavailableRecord')
    if (!spec) return row[field] == null ? t('nullValue') : String(row[field])
    return spec.ui?.signedBy ? signedValue(row, spec, row[field], i18n.language) : formatFieldValue(row[field], spec, i18n.language, key => t(key, { context: entity }))
  }
  const content = (widget: ConsoleWidgetResult) => {
    if (widget.kind === 'stat') {
      const configured = page.widgets?.find(item => item.id === widget.id)
      const empty = widget.value === null || widget.value === 0 && configured?.kind === 'stat' && configured.aggregate.fn === 'count'
      return <>{widget.value !== null && <p className="text-3xl font-semibold tabular-nums">{new Intl.NumberFormat(i18n.language).format(widget.value)}</p>}{empty && <p className="text-sm text-muted-foreground">{t('dashboardEmpty')}</p>}</>
    }
    if (!widget.data.length) return <p className="text-sm text-muted-foreground">{t('dashboardEmpty')}</p>
    if (widget.kind === 'list') return <ul className="space-y-2 text-sm">{widget.data.map((row, index) => <li key={String(row.id ?? index)}>{value(widget, row, widget.field)}</li>)}</ul>
    const entity = page.widgets?.find(item => item.id === widget.id)?.query.entity
    const fieldLabel = (field: string) => t(`field_${field}`, { context: entity })
    return <div className="generated-related-records">
      <table aria-label={t(widget.label)} className="generated-relation-table"><thead><tr>{widget.columns.map(field => <th key={field} scope="col">{fieldLabel(field)}</th>)}</tr></thead>
        <tbody>{widget.data.map((row, index) => <tr key={String(row.id ?? index)}>{widget.columns.map(field => <td key={field}>{value(widget, row, field)}</td>)}</tr>)}</tbody></table>
      <ul aria-label={t(widget.label)} className="generated-relation-cards">{widget.data.map((row, index) => <li key={String(row.id ?? index)}><dl>{widget.columns.map(field => <div key={field}><dt>{fieldLabel(field)}</dt><dd>{value(widget, row, field)}</dd></div>)}</dl></li>)}</ul>
    </div>
  }
  // Successful responses contain only server-authorized widgets; denied cards never mount.
  const widgets = result ? result.widgets : page.widgets ?? []
  if (!widgets.length) return <p className="text-sm text-muted-foreground">{t('dashboardEmpty')}</p>
  return <DetailCards sections={result ? result.sections : page.sections} cards={widgets.map(widget => ({ key: widget.id, content: <Card className="min-w-0" data-widget={widget.id}>
    <CardHeader><CardTitle><h2>{t(widget.label)}</h2></CardTitle></CardHeader><CardContent className="space-y-3">{error ? <p role="alert">{t('requestFailed')}</p> : pending ? <Skeleton role="status" aria-label={t('loading')} className="h-16 w-full" /> : content(widget as ConsoleWidgetResult)}</CardContent>
  </Card> }))} />
}
