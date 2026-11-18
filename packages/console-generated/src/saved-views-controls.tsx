import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@workbasehq/ui/components/ui/button'
import type { ListState } from './list-model'
import { changeSavedViews, loadSavedViews, onSavedViewsCleared, savedViewsKey, type SavedViewsChange, type SavedViewsScope } from './saved-views'

/** Keyed by the verified namespace: a scope change discards forms and stale handlers. */
export function SavedViewsControls(props: { scope: SavedViewsScope; entity: string; state: ListState; onApply: (search: unknown) => void }) {
  return <Catalogue key={savedViewsKey(props.scope, props.entity)} {...props} />
}
function Catalogue({ scope, entity, state, onApply }: Parameters<typeof SavedViewsControls>[0]) {
  const { t } = useTranslation()
  const [catalogue, setCatalogue] = useState(() => loadSavedViews(scope, entity))
  const [selected, setSelected] = useState(''), [editing, setEditing] = useState<'save' | 'rename'>(), [name, setName] = useState('')
  const [message, setMessage] = useState(''), [disabled, setDisabled] = useState(false)
  const active = useRef(true), select = useRef<HTMLSelectElement>(null), save = useRef<HTMLButtonElement>(null)
  const entry = catalogue.entries.find(item => item.id === selected)
  useLayoutEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useEffect(() => {
    const refresh = (event: StorageEvent) => {
      if (event.key !== null && event.key !== savedViewsKey(scope, entity)) return
      setCatalogue(loadSavedViews(scope, entity)); setMessage(''); setEditing(undefined)
    }
    window.addEventListener('storage', refresh)
    const unsubscribe = onSavedViewsCleared(account => {
      if (account && (account.instance !== scope.instance || account.userId !== scope.userId)) return
      active.current = false; setDisabled(true); setCatalogue({ entries: [] }); setEditing(undefined); setSelected(''); setMessage('')
    })
    return () => { window.removeEventListener('storage', refresh); unsubscribe() }
  }, [scope.instance, scope.userId, scope.orgId, entity])
  const mutate = (change: SavedViewsChange) => {
    if (!active.current) return
    const result = changeSavedViews(scope, entity, change)
    setCatalogue(result); setMessage(result.error ? `savedViewsError_${result.error}` : 'savedViewsChanged')
    if (result.error) return
    if (change.kind === 'save') setSelected(result.entries.at(-1)!.id)
    if (change.kind === 'delete') setSelected('')
    setEditing(undefined)
    if (change.kind === 'delete') save.current?.focus()
    else select.current?.focus()
  }
  return <section aria-label={t('savedViews')} className="space-y-2 py-2">
    <p className="text-sm text-muted-foreground">{t('savedViewsBrowserOnly')}</p>
    <div className="flex flex-wrap items-center gap-2">
      <select ref={select} aria-label={t('savedViews')} className="w-80 min-w-0 max-w-full rounded-md border bg-background p-2 text-sm" value={entry?.id ?? ''} disabled={disabled} onChange={event => { setSelected(event.target.value); setEditing(undefined); setMessage('') }}>
        <option value="">{t('savedViewsChoose')}</option>
        {catalogue.entries.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
      <Button ref={save} variant="outline" disabled={disabled} onClick={() => { if (active.current) { setEditing('save'); setName(''); setMessage('') } }}>{t('savedViewsSave')}</Button>
      <Button variant="outline" disabled={disabled || !entry} onClick={() => { if (active.current && entry) onApply(entry.search) }}>{t('savedViewsApply')}</Button>
      <Button variant="outline" disabled={disabled || !entry} onClick={() => { if (active.current && entry) { setEditing('rename'); setName(entry.name); setMessage('') } }}>{t('savedViewsRename')}</Button>
      <Button variant="outline" disabled={disabled || !entry} onClick={() => { if (entry) mutate({ kind: 'update', id: entry.id, state }) }}>{t('savedViewsUpdate')}</Button>
      <Button variant="outline" disabled={disabled || !entry} onClick={() => { if (entry) mutate({ kind: 'delete', id: entry.id }) }}>{t('savedViewsDelete')}</Button>
    </div>
    {editing && <form className="flex flex-wrap items-center gap-2" onSubmit={event => { event.preventDefault(); if (editing === 'save') mutate({ kind: 'save', name, state }); else if (entry) mutate({ kind: 'rename', id: entry.id, name }) }}>
      <label className="flex w-80 min-w-0 max-w-full flex-col gap-1 text-sm">{t('savedViewsName')} <input autoFocus className="w-full min-w-0 rounded-md border bg-background p-2" value={name} onChange={event => setName(event.target.value)} /></label>
      <Button type="submit">{t('savedViewsConfirm')}</Button>
      <Button type="button" variant="ghost" onClick={() => { setEditing(undefined); (entry ? select.current : save.current)?.focus() }}>{t('cancel')}</Button>
    </form>}
    {(message || catalogue.error) && <p role={message.startsWith('savedViewsError_') || catalogue.error ? 'alert' : 'status'} className="text-sm">{t(message || `savedViewsError_${catalogue.error}`)}</p>}
  </section>
}
