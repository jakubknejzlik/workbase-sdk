import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button } from '@workbasehq/ui'
import { Card, CardHeader, CardTitle, CardContent } from '@workbasehq/ui/components/ui/card'
import { GeneratedCreateDialog, GeneratedCollectionCommandDialog, type WriteRequest } from '@workbasehq/console-generated/writes'
import type { ConsolePage, ConsolePageAction } from '../../core/src/console-contract'
import { ReferenceAuthority } from '../../console-generated/src/reference-authority'
import { api } from './api/client'
import { useOrganization } from './api/queries'
import { refreshRuntimeModel, type RuntimeConsole, type useRuntimeModel } from './api/runtime-model'
import { NavigationIconView } from './navigation-icons'

type Slots = { header?: ReactNode; actions?: ReactNode }
/** Descriptors come only from the current authenticated E2 projection. */
export function DashboardActions({ orgId, page, runtime, children }: {
  orgId: string; page: ConsolePage; runtime: ReturnType<typeof useRuntimeModel>; children: (slots: Slots) => ReactNode
}) {
  const me = useOrganization(orgId)
  const data = runtime.error || me.error ? undefined : runtime.data
  const actor = me.isSuccess ? me.data.user?.id : undefined
  if (!data || !actor) return children({})
  return <ReferenceAuthority.Provider value={{ actor, observedAt: runtime.dataUpdatedAt }}>
    <ActionScope key={JSON.stringify([data.model.instance, actor, orgId, page.id])} orgId={orgId} pageId={page.id} data={data}
      blocked={runtime.isFetching || me.isFetching} children={children} />
  </ReferenceAuthority.Provider>
}

function ActionScope({ orgId, pageId, data, blocked, children }: {
  orgId: string; pageId: string; data: RuntimeConsole; blocked: boolean; children: (slots: Slots) => ReactNode
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [selected, setSelected] = useState<ConsolePageAction>()
  const [denied, setDenied] = useState<string[]>([])
  const trigger = useRef<HTMLElement | null>(null)
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const actions = (data.console.pages.find(page => page.id === pageId)?.actions ?? []).filter(action => !denied.includes(action.id))
  const selection = actions.find(action => action.id === selected?.id && JSON.stringify(action.target) === JSON.stringify(selected.target))
  useEffect(() => { if (selected && !selection) setSelected(undefined) }, [selected, selection])
  const latest = useRef({ selection, blocked }); latest.current = { selection, blocked }
  const write: WriteRequest = async (...args) => {
    // Queued form work may outlive the removed action, dialog or organization.
    if (!active.current || latest.current.blocked || !latest.current.selection || latest.current.selection.id !== selection?.id) throw { code: 'action_unavailable' }
    const [path, method, body, idempotencyKey] = args
    const result = await api(path, { method, body, orgId, idempotencyKey })
    await client.invalidateQueries({ queryKey: ['console-page', orgId] })
    return result
  }
  const open = (action: ConsolePageAction) => { trigger.current = document.activeElement as HTMLElement; setSelected(action) }
  const label = (key: string) => t(key, { defaultValue: key })
  const control = (action: ConsolePageAction, card = false) => {
    const className = card ? 'dashboard-action' : undefined
    const content = card ? <><span className="dashboard-action-icon" aria-hidden="true"><NavigationIconView name={action.icon ?? 'Database'} /></span><span className="dashboard-action-copy"><span className="dashboard-action-title">{label(action.label)}</span>{action.description && <span className="dashboard-action-description">{label(action.description)}</span>}</span></> : label(action.label)
    const props = { className, 'data-primary': action.primary ? 'true' : undefined }
    const target = action.target
    if ('navigation' in target) {
      const item = data.console.navigation.find(item => item.id === target.navigation)
      const page = data.console.pages.find(page => page.id === item?.page)
      if (!item || !page && !item.entity) return null
      return <Button {...props} asChild variant={action.primary ? 'default' : 'outline'}><Link to={'/o/' + encodeURIComponent(orgId) + (page?.path ?? '/e/' + item.entity)} search={item.view ? { view: item.view } : {}}>{content}</Link></Button>
    }
    return <Button {...props} variant={action.primary ? 'default' : 'outline'} disabled={blocked} onClick={() => open(action)}>{content}</Button>
  }
  const primary = actions.find(action => action.primary)
  const target = selection?.target
  const command = target && 'command' in target ? data.model.commands?.find(command => command.name === target.command) : undefined
  const entity = target && 'create' in target ? target.create : command?.ui?.placement?.entity ?? command?.permission.entity
  const mutation = entity ? {
    model: data.model, caps: data.capabilities, orgId, entity, readBlocked: blocked, write,
    request: (query: import('@workbasehq/console-generated/read').ReadQuery) => api<import('@workbasehq/console-generated/read').Result>('/query', { method: 'POST', body: query, orgId }),
    onDenied: () => { if (selection) setDenied(previous => [...previous, selection.id]); setSelected(undefined); void refreshRuntimeModel(client, orgId) },
    open: true, onOpenChange: (open: boolean) => { if (!open) setSelected(undefined) },
    onCloseAutoFocus: (event: Event) => { if (trigger.current?.isConnected) { event.preventDefault(); trigger.current.focus() } },
  } : undefined
  return <>{children({
    header: primary && control(primary),
    actions: actions.length ? <section className="dashboard-actions" aria-label={t('dashboardQuickActions')}><Card className="dashboard-card"><CardHeader><CardTitle><h2>{t('dashboardQuickActions')}</h2></CardTitle></CardHeader><CardContent className="dashboard-action-grid">{actions.map(action => <div key={action.id}>{control(action, true)}</div>)}</CardContent></Card></section> : undefined,
  })}
    {mutation && target && ('create' in target ? <GeneratedCreateDialog key={selection!.id} {...mutation} /> : command ? <GeneratedCollectionCommandDialog key={selection!.id} {...mutation} name={command.name} /> : null)}
  </>
}
