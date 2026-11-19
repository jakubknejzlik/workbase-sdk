import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@workbasehq/ui/components/ui/button'
import { Checkbox } from '@workbasehq/ui/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@workbasehq/ui/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@workbasehq/ui/components/ui/popover'
import type { ListState } from './list-model'
import { changeSavedViews, loadSavedViews, onSavedViewsCleared, savedViewsKey, type SavedViewsChange, type SavedViewsScope } from './saved-views'

interface Props {
  scope: SavedViewsScope; entity: string; state: ListState
  /** Identity of the confirmed saved-view settings; draft panel state never reaches it. */
  current: string
  /** Identity of the baseline an unsaved list is compared with. */
  initial: string
  /** Identity of a stored search after revalidation against the current authority. */
  fingerprint: (search: unknown) => string
  onApply: (search: unknown) => void | Promise<unknown>
}
type Dialogue = { kind: 'save'; asNew: boolean } | { kind: 'rename' } | { kind: 'delete' }
/** Keyed by the verified namespace: a scope change discards the active view, forms and stale handlers. */
export function SavedViewsControls(props: Props) {
  return <Catalogue key={savedViewsKey(props.scope, props.entity)} {...props} />
}
function Catalogue({ scope, entity, state, current, initial, fingerprint, onApply }: Props) {
  const { t } = useTranslation()
  const [catalogue, setCatalogue] = useState(() => loadSavedViews(scope, entity))
  // The applied baseline is separate from the menu's candidate selection: choosing never changes the list.
  const [activeId, setActiveId] = useState(''), [candidate, setCandidate] = useState('')
  const [open, setOpen] = useState(false), [dialogue, setDialogue] = useState<Dialogue>(), [name, setName] = useState(''), [update, setUpdate] = useState(true)
  const [message, setMessage] = useState(''), [disabled, setDisabled] = useState(false), [settling, setSettling] = useState(false)
  const active = useRef(true), trigger = useRef<HTMLButtonElement>(null)
  const outsideInteraction = useRef(false)
  const entry = catalogue.entries.find(item => item.id === activeId)
  useLayoutEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useEffect(() => {
    const refresh = (event: StorageEvent) => {
      if (event.key !== null && event.key !== savedViewsKey(scope, entity)) return
      setCatalogue(loadSavedViews(scope, entity)); setMessage(''); setDialogue(undefined)
    }
    window.addEventListener('storage', refresh)
    const unsubscribe = onSavedViewsCleared(account => {
      if (account && (account.instance !== scope.instance || account.userId !== scope.userId)) return
      active.current = false; setDisabled(true); setCatalogue({ entries: [] }); setDialogue(undefined); setOpen(false); setActiveId(''); setCandidate(''); setMessage('')
    })
    return () => { window.removeEventListener('storage', refresh); unsubscribe() }
  }, [scope.instance, scope.userId, scope.orgId, entity])
  // A view deleted elsewhere can no longer be the baseline.
  useEffect(() => { if (activeId && !entry) setActiveId('') }, [activeId, entry])
  const baseline = entry ? fingerprint(entry.search) : initial
  // Search text, paging and the draft panel are outside the saved settings; only confirmed state is compared.
  const dirty = current !== baseline && !settling
  useEffect(() => { if (settling && current === baseline) setSettling(false) }, [settling, current, baseline])
  const mutate = (change: SavedViewsChange, close = true) => {
    if (!active.current) return false
    const result = changeSavedViews(scope, entity, change)
    setCatalogue(result); setMessage(result.error ? `savedViewsError_${result.error}` : 'savedViewsChanged')
    if (result.error) return false
    if (change.kind === 'save') { const saved = result.entries.at(-1)!.id; setActiveId(saved); setCandidate(saved) }
    if (change.kind === 'delete') { setActiveId(''); setCandidate('') }
    if (close) setDialogue(undefined)
    return true
  }
  const openDialogue = (next: Dialogue, value = '') => { if (!active.current) return; setOpen(false); setName(value); setUpdate(next.kind === 'save' && !next.asNew && !!entry); setMessage(''); setDialogue(next) }
  const saveFromBar = () => openDialogue({ kind: 'save', asNew: !entry }, entry?.name ?? '')
  const apply = (id: string) => {
    const target = catalogue.entries.find(item => item.id === id)
    if (!active.current || !target) return
    setActiveId(target.id); setSettling(true); setOpen(false)
    void Promise.resolve(onApply(target.search)).finally(() => setSettling(false))
  }
  const submit = () => {
    if (dialogue?.kind === 'rename' && entry) mutate({ kind: 'rename', id: entry.id, name })
    else if (dialogue?.kind === 'save' && !dialogue.asNew && update && entry) {
      // Name first: a refused name leaves both the stored view and the open dialog untouched.
      if (name.trim() === entry.name || mutate({ kind: 'rename', id: entry.id, name }, false)) mutate({ kind: 'update', id: entry.id, state })
    } else if (dialogue?.kind === 'save') mutate({ kind: 'save', name, state })
  }
  const selected = candidate && catalogue.entries.some(item => item.id === candidate) ? candidate : activeId && entry ? activeId : catalogue.entries[0]?.id ?? ''
  const status = message || catalogue.error ? t(message || `savedViewsError_${catalogue.error}`) : ''
  const failed = message.startsWith('savedViewsError_') || !!catalogue.error
  return <section aria-label={t('savedViews')} className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
    {dirty && <Button type="button" variant="outline" disabled={disabled} onClick={saveFromBar}>{entry ? t('savedViewsSaveChanges') : t('savedViewsSaveView')}</Button>}
    <Popover open={open} onOpenChange={value => { if (value) { outsideInteraction.current = false; setCandidate(selected); setMessage('') } setOpen(value) }}>
      <PopoverTrigger asChild><Button ref={trigger} type="button" variant="outline" disabled={disabled} className="max-w-full min-w-0">
        <span className="min-w-0 truncate">{entry?.name ?? t('savedViewsMenu')}</span>
        {dirty && <span role="img" aria-label={t('savedViewsUnsaved')} title={t('savedViewsUnsaved')} className="size-2 shrink-0 rounded-full bg-amber-500" />}

      </Button></PopoverTrigger>
      <PopoverContent onInteractOutside={event => { outsideInteraction.current = !trigger.current?.contains(event.target as Node) }} onCloseAutoFocus={event => { event.preventDefault(); if (!dialogue && !outsideInteraction.current) trigger.current?.focus() }} role="dialog" aria-label={t('savedViews')} align="end" className="grid w-80 max-w-[calc(100vw-1.5rem)] max-h-[var(--radix-popover-content-available-height)] gap-2 overflow-y-auto">
        <div><p className="text-sm font-semibold">{t('savedViewsHeading')}</p><p className="text-xs text-muted-foreground">{t('savedViewsHint')}</p></div>
        {catalogue.entries.length ? <ul className="grid min-w-0 gap-1" aria-label={t('savedViewsHeading')}>{catalogue.entries.map(item => <li key={item.id} className="min-w-0">
          <button type="button" aria-pressed={selected === item.id} className="flex min-h-9 min-w-0 w-full items-center justify-between gap-2 rounded-md px-2 text-left text-sm hover:bg-muted aria-pressed:bg-muted aria-pressed:font-semibold" onClick={() => { setCandidate(item.id); setMessage('') }}><span className="min-w-0 [overflow-wrap:anywhere]">{item.name}</span>{selected === item.id && <span aria-hidden="true">✓</span>}</button>
        </li>)}</ul> : <p className="text-xs text-muted-foreground">{t('savedViewsEmpty')}</p>}
        <hr />
        <Button type="button" variant="ghost" className="justify-start" onClick={() => openDialogue({ kind: 'save', asNew: true })}>{t('savedViewsSaveNew')}</Button>
        {entry && <>
          <Button type="button" variant="ghost" className="justify-start" onClick={() => openDialogue({ kind: 'rename' }, entry.name)}>{t('savedViewsRenameThis')}</Button>
          <Button type="button" variant="ghost" className="justify-start text-destructive" onClick={() => openDialogue({ kind: 'delete' })}>{t('savedViewsDeleteThis')}</Button>
        </>}
        {dirty && selected && <p role="status" className="rounded-md bg-amber-50 p-2 text-xs text-amber-900">{t('savedViewsDiscardWarning')}</p>}
        <div className="flex justify-end gap-2"><Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>{t('savedViewsClose')}</Button><Button type="button" size="sm" disabled={!selected} onClick={() => apply(selected)}>{t('savedViewsApplyView')}</Button></div>
        <p className="text-xs text-muted-foreground">{t('savedViewsBrowserOnly')}</p>
      </PopoverContent>
    </Popover>
    {status && !(failed && dialogue) && <p role={failed ? 'alert' : 'status'} className="text-sm">{status}</p>}
    <Dialog open={!!dialogue} onOpenChange={value => { if (!value) setDialogue(undefined) }}>
      <DialogContent onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus() }}>
        {dialogue?.kind === 'delete' && entry ? <>
          <DialogHeader><DialogTitle>{t('savedViewsDeleteTitle')}</DialogTitle><DialogDescription>{t('savedViewsDeleteBody', { name: entry.name })}</DialogDescription></DialogHeader>
          <DialogFooter><Button type="button" variant="outline" onClick={() => setDialogue(undefined)}>{t('cancel')}</Button><Button type="button" variant="destructive" onClick={() => { mutate({ kind: 'delete', id: entry.id }) }}>{t('savedViewsDelete')}</Button></DialogFooter>
        </> : dialogue && <form className="grid gap-4" onSubmit={event => { event.preventDefault(); submit() }}>
          <DialogHeader><DialogTitle>{dialogue.kind === 'rename' ? t('savedViewsDialogRename') : t('savedViewsDialogSave')}</DialogTitle><DialogDescription>{t('savedViewsNotice')} {t('savedViewsBrowserOnly')}</DialogDescription></DialogHeader>
          <label className="grid min-w-0 gap-1 text-sm">{t('savedViewsName')}<input autoFocus className="w-full min-w-0 rounded-md border bg-background p-2" value={name} onChange={event => setName(event.target.value)} /></label>
          {dialogue.kind === 'save' && !dialogue.asNew && entry && <label className="flex items-center gap-2 text-sm"><Checkbox checked={update} onCheckedChange={value => setUpdate(value === true)} />{t('savedViewsUpdateCurrent')}</label>}
          {failed && status && <p role="alert" className="text-sm text-destructive">{status}</p>}
          <DialogFooter><Button type="button" variant="outline" onClick={() => setDialogue(undefined)}>{t('cancel')}</Button><Button type="submit">{t('savedViewsConfirm')}</Button></DialogFooter>
        </form>}
      </DialogContent>
    </Dialog>
  </section>
}
