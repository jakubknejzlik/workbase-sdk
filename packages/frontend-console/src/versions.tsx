import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Card, CardHeader, CardTitle, CardContent } from '@workbasehq/ui/components/ui/card'
import { Button } from '@workbasehq/ui/components/ui/button'
import type { ConfigChange, VersionHistory } from '../../core/src/migrations/version-contract'
import { api } from './api/client'
import { Loading, Page, QueryError } from './screens'

export function VersionsPage({ orgId }: { orgId: string }) {
  const { t, i18n } = useTranslation()
  const [selected, select] = useState<number>()
  const history = useQuery({ queryKey: ['config-versions', orgId], queryFn: () => api<VersionHistory>(`/o/${encodeURIComponent(orgId)}/config-versions`), refetchOnWindowFocus: true })
  if (history.error) return <QueryError error={history.error} />
  if (!history.data) return <Loading />
  const versions = history.data.versions
  const version = versions.find(v => v.revision === selected) ?? versions.at(-1)
  const summary = (changes: ConfigChange[]) => {
    const counts = new Map<string, number>()
    for (const change of changes) { const key = `version_${change.kind}_${change.change}`; counts.set(key, (counts.get(key) ?? 0) + 1) }
    return counts.size ? [...counts].map(([key, count]) => t(key, { count })).join(' · ') : t('versionNoChanges')
  }
  return <Page title={t('configVersions')}><div className="min-w-0 space-y-6">
    <p className="text-muted-foreground">{t('versionHistoryHelp', { instance: history.data.instance })}</p>
    <Card><CardHeader><CardTitle><h2>{t('versionHistory')}</h2></CardTitle></CardHeader><CardContent>
      <ul className="max-h-80 divide-y overflow-y-auto">{[...versions].reverse().map(item => <li key={item.revision} className="py-3">
        <button type="button" className="w-full rounded-md p-2 text-left hover:bg-muted aria-pressed:bg-muted focus-visible:outline-2 focus-visible:outline-ring" aria-pressed={item.revision === version?.revision} onClick={() => select(item.revision)}>
          <span className="font-semibold">v{item.revision}</span>{item.revision === history.data.currentRevision && <span className="ml-2 text-sm text-muted-foreground">{t('versionCurrent')}</span>}
          <span className="mt-1 block text-sm text-muted-foreground">{item.date ? new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.date)) : t('versionDateUnavailable')}{item.commit && ` · ${item.commit}`}</span>
          <span className="mt-1 block text-sm">{summary(item.changes)}</span>
        </button>
      </li>)}</ul>
    </CardContent></Card>
    {version && <>
      <Card><CardHeader><CardTitle><h2>{version.predecessor ? t('versionDiffTitle', { from: `v${version.predecessor}`, to: `v${version.revision}` }) : t('versionInitialTitle', { version: `v${version.revision}` })}</h2></CardTitle></CardHeader><CardContent>
        <ConfigDiff changes={version.changes} />
      </CardContent></Card>
      <Card><CardHeader><CardTitle><h2>{t('versionRollbackTitle', { version: `v${version.revision}` })}</h2></CardTitle></CardHeader><CardContent className="min-w-0 space-y-4">
        <p id="rollback-explanation" className="text-sm text-muted-foreground">{t('versionRollbackDisabled')}</p>
        <Button disabled aria-describedby="rollback-explanation">{t('versionRollback')}</Button>
        {version.rollback.unchanged ? <p>{t('versionAlreadyMatches')}</p> : <p>{t('versionCreatesRevision', { version: `v${version.rollback.newRevision}` })}</p>}
        <details open><summary className="cursor-pointer font-medium">{t('versionPlanPreview')}</summary>
          {!!version.rollback.blocked.length && <div role="status" className="mt-3 rounded border border-destructive p-3"><p className="font-medium">{t('versionPlanBlocked')}</p><ul className="list-inside list-disc text-sm">{version.rollback.blocked.map(reason => <li key={reason}>{reason}</li>)}</ul></div>}
          {!!version.rollback.destructive.length && <ul className="mt-3 list-inside list-disc text-sm">{version.rollback.destructive.map(reason => <li key={reason}>{reason}</li>)}</ul>}
          {version.rollback.warnings.map(warning => <p className="mt-3 text-sm" key={warning}>{warning}</p>)}
          <pre aria-label={t('versionPlanPreview')} className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">{version.rollback.sql}</pre>
        </details>
      </CardContent></Card>
    </>}
  </div></Page>
}

export function ConfigDiff({ changes }: { changes: ConfigChange[] }) {
  const { t } = useTranslation()
  return <>{!changes.length ? <p>{t('versionNoChanges')}</p> : <ul className="max-h-96 space-y-3 overflow-y-auto">{changes.map(change => <li key={`${change.kind}:${change.path}`} className="min-w-0 rounded-md border p-3">
          <details><summary className="cursor-pointer break-words text-sm"><span className="font-medium">{t(`versionChange_${change.change}`)}</span> · {change.path}</summary>
            <div className="mt-3 grid min-w-0 gap-3 md:grid-cols-2">{(['before', 'after'] as const).map(side => <div key={side} className="min-w-0"><p className="text-sm font-medium">{t(`version_${side}`)}</p><pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">{Object.hasOwn(change, side) ? JSON.stringify(change[side], null, 2) : '—'}</pre></div>)}</div>
          </details>
        </li>)}</ul>}</>
}
