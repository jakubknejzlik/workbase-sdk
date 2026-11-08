import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useForm, type FieldValues, type UseFormProps } from 'react-hook-form'
import { FormSubmitButton } from '../components/form/FormSubmitButton'
import { FormSubmissionContext } from '../components/form/Form'
import { toast } from 'sonner'
import { Button } from '../button'

export interface MutationLabels {
  saving: string; saved: string; close: string
  discardTitle: string; discardMessage: string; discard: string; continueEditing: string
}
const defaults: MutationLabels = { saving: 'Saving…', saved: 'Saved', close: 'Close', discardTitle: 'Discard changes?', discardMessage: 'You have unsaved changes that will be lost.', discard: 'Discard', continueEditing: 'Continue Editing' }
const Labels = createContext(defaults)
export const MutationLabelsProvider = Labels.Provider
export const useMutationLabels = () => useContext(Labels)

interface Lifecycle {
  dirty: boolean; pending: boolean; confirming: boolean; cancelLabel: string; submissionKey: string
  setForm: (dirty: boolean, reset?: () => void, owner?: symbol) => void
  removeForm: (owner: symbol) => void
  cancel: () => void; complete: () => void
  run: (action: () => Promise<unknown>) => Promise<void>
}
const Session = createContext<Lifecycle | null>(null)
export const useMutationSession = () => useContext(Session)
interface NavigationGuard { blocked: () => boolean; request: () => Promise<boolean> }
const guards = new Set<NavigationGuard>()
export const hasUnsavedMutation = () => [...guards].some(guard => guard.blocked())
/** Returns the router's shouldBlock result. A pending request never navigates. */
export async function blockMutationNavigation() {
  for (const guard of [...guards].reverse()) if (guard.blocked() && await guard.request()) return true
  return false
}

/** One controller per open, above source content (including its inline discard UI).
 * It owns the submission latch/key, reset, navigation decision and late completion.
 * No values, errors or credentials enter notifications or a global store.
 */
export function MutationSession({ children, close, cancelLabel, confirming = false }: {
  children: (session: Lifecycle & { reset: () => void; closeRequest: number; continueEditing: () => void }) => ReactNode
  close: () => void; cancelLabel: string; confirming?: boolean
}) {
  const labels = useMutationLabels()
  const [dirty, setDirty] = useState(false); const [pending, setPending] = useState(false)
  const [closeRequest, requestClose] = useState(0)
  const [submissionKey] = useState(() => crypto.randomUUID())
  const forms = useRef(new Map<symbol, { dirty: boolean; reset?: () => void }>())
  const [defaultOwner] = useState(() => Symbol('form'))
  const latch = useRef(false); const mounted = useRef(true); const completeRequested = useRef(false)
  const decision = useRef<((blocked: boolean) => void) | undefined>(undefined)
  const state = useRef({ dirty, pending }); state.current = { dirty, pending }
  useEffect(() => {
    mounted.current = true
    const guard: NavigationGuard = {
      blocked: () => !completeRequested.current && (state.current.dirty || latch.current),
      request: () => {
        if (latch.current) return Promise.resolve(true)
        // A second navigation cancels the earlier attempt, never overwrites it.
        decision.current?.(true)
        requestClose(value => value + 1)
        return new Promise(resolve => { decision.current = resolve })
      },
    }
    guards.add(guard)
    return () => { mounted.current = false; guards.delete(guard); decision.current?.(true) }
  }, [])
  const updateDirty = () => {
    const next = [...forms.current.values()].some(form => form.dirty)
    state.current.dirty = next; setDirty(next)
  }
  const session: Lifecycle = {
    dirty, pending, confirming, cancelLabel, submissionKey,
    setForm: (next, reset, owner = defaultOwner) => { forms.current.set(owner, { dirty: next, reset }); updateDirty() },
    removeForm: owner => { forms.current.delete(owner); updateDirty() },
    cancel: () => { if (!latch.current) requestClose(value => value + 1) },
    complete: () => { if (!mounted.current) return; completeRequested.current = true; if (latch.current) toast.success(labels.saved, { id: 'mutation-saved' }); close() },
    run: async action => {
      if (latch.current) return
      latch.current = true; setPending(true); completeRequested.current = false
      try {
        await action()
        if (mounted.current) {
          if (!completeRequested.current) toast.success(labels.saved, { id: 'mutation-saved' })
        }
      } catch {
        // Consumers render translated, closed-code inline errors and retain values.
        completeRequested.current = false
      } finally {
        latch.current = false
        if (mounted.current) setPending(false)
      }
    },
  }
  const reset = () => {
    for (const form of [...forms.current.values()]) { form.dirty = false; form.reset?.() }
    updateDirty(); decision.current?.(false); decision.current = undefined
  }
  const continueEditing = () => { decision.current?.(true); decision.current = undefined }
  return <Session.Provider value={session}>{children({ ...session, reset, closeRequest, continueEditing })}</Session.Provider>
}

/** RHF stays mounted above the source dialog's replaceable presentation. */
export function useMutationForm<T extends FieldValues>(options: UseFormProps<T>, track = true) {
  const form = useForm<T>(options)
  useMutationState(form.formState.isDirty, () => form.reset(), track)
  return form
}
export function useMutationState(dirty: boolean, reset?: () => void, track = true) {
  const session = useMutationSession()
  const resetRef = useRef(reset); resetRef.current = reset
  const [owner] = useState(() => Symbol('mutation form'))
  useLayoutEffect(() => { if (track) session?.setForm(dirty, () => resetRef.current?.(), owner) }, [dirty, track, owner])
  useLayoutEffect(() => () => { if (track) session?.removeForm(owner) }, [track, owner])
}
/** Same synchronous latch for dialog and page mutations, including native forms. */
export function useMutationSubmit() {
  const session = useMutationSession(); const labels = useMutationLabels(); const latch = useRef(false)
  return async (action: () => Promise<unknown>) => {
    if (session) return session.run(action)
    if (latch.current) return
    latch.current = true
    try { await action(); toast.success(labels.saved, { id: 'mutation-saved' }) } catch { /* inline consumer error */ } finally { latch.current = false }
  }
}
export function MutationSubmitButton({ children, pending = false, footer = true, disabled, ...props }: React.ComponentProps<typeof Button> & { pending?: boolean; footer?: boolean }) {
  const session = useMutationSession(); const labels = useMutationLabels()
  if (session?.confirming) return null
  const busy = pending || session?.pending
  const button = <FormSubmissionContext.Provider value={{ isSubmitting: !!busy }}><FormSubmitButton {...props} loadingText={labels.saving} disabled={disabled || busy} aria-busy={busy || undefined}>{children}</FormSubmitButton></FormSubmissionContext.Provider>
  return session && footer ? <div className="flex justify-end gap-2" data-slot="mutation-footer"><Button type="button" variant="outline" disabled={busy} onClick={session.cancel}>{session.cancelLabel}</Button>{button}</div> : button
}
