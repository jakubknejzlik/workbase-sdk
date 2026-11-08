import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link } from '@tanstack/react-router'
import { Button } from '@workbasehq/ui/components/ui/button'
import { Card, CardHeader, CardTitle, CardContent } from '@workbasehq/ui/components/ui/card'
import type { ConfigProposal } from '../../core/src/config-proposal-contract'
import { api, ApiError } from './api/client'
import { Page } from './screens'
import { ConfigDiff } from './versions'

export function ChangesPage({ orgId }: { orgId: string }) {
  const { t } = useTranslation(); const client = useQueryClient()
  const [prompt, setPrompt] = useState('')
  const [proposal, setProposal] = useState<ConfigProposal>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const [applied, setApplied] = useState<number>()
  const submit = async (action: 'propose' | 'apply') => {
    setPending(true); setError(undefined)
    try {
      const path = `/o/${encodeURIComponent(orgId)}/config-changes/${action}`
      if (action === 'propose') { setProposal(undefined); setApplied(undefined); setProposal(await api<ConfigProposal>(path, { method: 'POST', body: { prompt } })) }
      else {
        const result = await api<{ revision: number }>(path, { method: 'POST', body: { proposalId: proposal!.proposalId } })
        setApplied(result.revision)
        await client.invalidateQueries({ queryKey: ['config-versions', orgId] })
      }
    } catch (cause) {
      const code = cause instanceof ApiError ? cause.code : 'request_failed'
      setError(t(`configChangeError_${code}`, { defaultValue: t('configChangeError') }))
      if (code === 'stale_revision') setProposal(undefined)
    } finally { setPending(false) }
  }
  return <Page title={t('configChanges')}><div className="min-w-0 space-y-6">
    <p className="text-muted-foreground">{t('configChangesHelp')}</p>
    <form className="space-y-3" onSubmit={event => { event.preventDefault(); void submit('propose') }}>
      <label htmlFor="config-prompt" className="block font-medium">{t('configPrompt')}</label>
      <textarea id="config-prompt" className="min-h-32 w-full rounded-md border bg-background p-3 text-sm" value={prompt} maxLength={2000} required disabled={pending} onChange={event => { setPrompt(event.target.value); setProposal(undefined); setApplied(undefined); setError(undefined) }} aria-describedby="config-prompt-help" />
      <p id="config-prompt-help" className="text-sm text-muted-foreground">{t('configPromptHelp')}</p>
      <Button type="submit" disabled={pending || !prompt.trim()}>{pending ? t('loading') : t('configPropose')}</Button>
    </form>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {proposal && <>
      <Card><CardHeader><CardTitle><h2>{t('versionDiffTitle', { from: `v${proposal.baseRevision}`, to: `v${proposal.revision}` })}</h2></CardTitle></CardHeader><CardContent><ConfigDiff changes={proposal.changes} /></CardContent></Card>
      <Card><CardHeader><CardTitle><h2>{t('versionPlanPreview')}</h2></CardTitle></CardHeader><CardContent>
        {proposal.plan.warnings.map(warning => <p key={warning}>{warning}</p>)}
        <pre aria-label={t('versionPlanPreview')} className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">{proposal.plan.sql}</pre>
      </CardContent></Card>
      <Button disabled={pending || applied !== undefined || !!proposal.plan.blocked.length || !!proposal.plan.destructive.length} onClick={() => void submit('apply')}>{t('configApply')}</Button>
    </>}
    {applied !== undefined && <div role="status" className="space-y-3"><p>{t('configApplied', { version: `v${applied}` })}</p><Link to="/o/$orgId/settings/$" params={{ orgId, _splat: 'versions' }} className="underline">{t('configVersions')}</Link></div>}
  </div></Page>
}
