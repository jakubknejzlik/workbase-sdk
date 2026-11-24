import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link } from '@tanstack/react-router'
import { Card, CardHeader, CardTitle, CardContent } from '@workbasehq/ui/components/ui/card'
import { Skeleton } from '@workbasehq/ui/components/ui/skeleton'
import { StaticDataTable } from '@workbasehq/ui'
import { TablePresentationContext, useTablePresentation } from '../../ui/src/data-table/presentation'
import { formatFieldValue, recordLabel, visibleEntities, type Model, type Capabilities } from '@workbasehq/console-generated/read'
import { signedValue } from '@workbasehq/console-generated/screens'
import { DetailCards } from '../../console-generated/src/detail-layout'
import { shortRecordId } from '../../console-generated/src/labels'
import { listColumnAlignment } from '../../console-generated/src/list-presentation'
import type { ConsolePage, ConsolePageResult, ConsoleWidgetResult } from '../../plugins/console/src/contract'
import { api } from './api/client'
import { useRuntimeModel } from './api/runtime-model'
import { Page } from './screens'
import type { ReactNode } from 'react'

/** Widget responses are bounded server results: render every returned row without local paging. */
function WidgetRecords({ widget, entity, model, value }: {
  widget: Exclude<ConsoleWidgetResult, { kind: 'stat' }>; entity?: string; model?: Model
  value: (row: Record<string, any>, field: string) => ReactNode
}) {
  const { t } = useTranslation()
  const presentation = useTablePresentation()
  const fields = widget.kind === 'list' ? [widget.field] : widget.columns
  const columns = fields.map((field, index) => ({
    id: field, header: t(`field_${field}`, { context: entity }), enableSorting: false,
    // Same explicit tracks as the console list, shared by colgroup, th and td.
    meta: { fixedWidth: false, align: model && entity && model.entities[entity] ? listColumnAlignment(model, entity, field) : 'left', widthClass: index === 0 ? 'w-56' : 'w-40' },
    cell: ({ row }: { row: { original: Record<string, any> } }) => <div className="whitespace-normal break-words">{value(row.original, field)}</div>,
  }))
  return <TablePresentationContext.Provider value={{ ...presentation, tableClass: 'w-full', listV2: true, scrollTabStop: 'overflow', scrollRegion: t('listScrollRegion'), scrollHint: t('listScrollHint') }}>
    <div data-list-density="comfortable" className="min-w-0 max-w-full"><StaticDataTable data={widget.data} columns={columns} label={t(widget.label)} /></div>
  </TablePresentationContext.Provider>
}

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
  const value = (widget: ConsoleWidgetResult, row: Record<string, any>, field: string, primary = false) => {
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
    const content = field === 'id' ? <span title={String(row.id)}>{shortRecordId(row.id)}</span>
      : !spec ? row[field] == null ? t('nullValue') : String(row[field])
      : spec.ui?.signedBy ? signedValue(row, spec, row[field], i18n.language) : formatFieldValue(row[field], spec, i18n.language, key => t(key, { context: entity }), model?.timeZone)
    // The page query already enforces row policies. Match the generated detail
    // page's eligibility, and never infer identity from an unselected field.
    const canOpen = primary && configured && configured.kind !== 'stat' && configured.query.select.includes('id')
      && entity && model && caps && visibleEntities(model, caps).includes(entity) && typeof row.id === 'string' && row.id.length > 0
    return canOpen ? <Link data-row-name="" title={row.id} to="/o/$orgId/e/$entity/$id" params={{ orgId, entity, id: row.id }}>{content}</Link> : content
  }
  const content = (widget: ConsoleWidgetResult) => {
    if (widget.kind === 'stat') {
      // Missing data shares the value line's height; zero is a normal value.
      return widget.value == null
        ? <p className="flex min-h-9 items-center text-sm text-muted-foreground">{t('dashboardEmpty')}</p>
        : <p className="text-3xl font-semibold tabular-nums">{new Intl.NumberFormat(i18n.language).format(widget.value)}</p>
    }
    if (!widget.data.length) return <p className="text-sm text-muted-foreground">{t('dashboardEmpty')}</p>
    const entity = page.widgets?.find(item => item.id === widget.id)?.query.entity
    // Reference-label cells keep their target links, including in column one.
    const configured = page.widgets?.find(item => item.id === widget.id)
    const primary = widget.kind === 'list' ? widget.field : widget.columns.find(field => model?.entities[entity ?? '']?.fields[field]?.type !== 'ref' && !(configured?.kind !== 'stat' && configured?.query.labels?.includes(field)))
    return <WidgetRecords widget={widget} entity={entity} model={model} value={(row, field) => value(widget, row, field, field === primary)} />
  }
  // Successful responses contain only server-authorized widgets; denied cards never mount.
  const widgets = result ? result.widgets : page.widgets ?? []
  if (!widgets.length) return <p className="text-sm text-muted-foreground">{t('dashboardEmpty')}</p>
  return <DetailCards sections={result ? result.sections : page.sections} cards={widgets.map(widget => ({ key: widget.id, content: <Card className="min-w-0" data-widget={widget.id}>
    <CardHeader><CardTitle><h2>{t(widget.label)}</h2></CardTitle></CardHeader><CardContent className="space-y-3">{error ? <p role="alert">{t('requestFailed')}</p> : pending ? <Skeleton role="status" aria-label={t('loading')} className="h-16 w-full" /> : content(widget as ConsoleWidgetResult)}</CardContent>
  </Card> }))} />
}
