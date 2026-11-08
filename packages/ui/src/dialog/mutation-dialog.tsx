import { useId, useRef, useState, type ReactNode, type ComponentProps } from 'react'
import { Plus, Pencil, Trash2 } from 'lucide-react'
import { Button } from '../button'
import { FormDialog } from '../components/dialog/FormDialog'
import { ConfirmDialog } from '../components/dialog/ConfirmDialog'
import { DeleteDialog, type DeleteDialogProps } from '../components/dialog/DeleteDialog'
import { schemaDialogWidth, type RegistrySchema } from '../form/schema'
import { MutationSession, useMutationLabels } from './mutation-lifecycle'
interface Props {
  trigger?: string; triggerLabel?: string; title: string; description: string; cancelLabel: string
  triggerIcon?: 'edit' | 'delete'; triggerVariant?: ComponentProps<typeof Button>['variant']
  disabledReason?: string; destructive?: boolean; compact?: boolean
  open?: boolean; onOpenChange?: (open: boolean) => void; onCloseAutoFocus?: (event: Event) => void
  children: (controls: { close: () => void; submissionKey: string }) => ReactNode
}
/** Compatibility bridge: all mutation state and presentation use the canonical path. */
export function ActionDialog(props: Props) { return <MutationDialog {...props} /> }
/** Schema-aware source dialog; the compatibility bridge keeps its original API. */
export function SchemaFormDialog({ schema, ...props }: Props & { schema: RegistrySchema }) { return <MutationDialog {...props} maxWidth={schemaDialogWidth(schema)} /> }
export function DeleteActionDialog(props: Props & Pick<DeleteDialogProps, 'entityType' | 'entityName' | 'targetDescription' | 'warningMessage' | 'confirmText'>) {
  return <MutationDialog {...props} destructive deleteTarget={props} />
}
function MutationDialog({ trigger, triggerLabel, triggerIcon, triggerVariant, title, description, cancelLabel, disabledReason, destructive = false, compact = false, children, open: controlledOpen, onOpenChange, onCloseAutoFocus, deleteTarget, maxWidth }: Props & { maxWidth?: string; deleteTarget?: Pick<DeleteDialogProps, 'entityType' | 'entityName' | 'targetDescription' | 'warningMessage' | 'confirmText'> }) {
  const labels = useMutationLabels(); const [internalOpen, setOpen] = useState(false)
  const open = controlledOpen ?? internalOpen
  const changeOpen = (next: boolean) => { setOpen(next); onOpenChange?.(next) }
  const triggerRef = useRef<HTMLButtonElement>(null); const content = useRef<HTMLDivElement>(null); const reasonId = useId()
  const restoreFocus = (event: Event) => { onCloseAutoFocus?.(event); if (!event.defaultPrevented && triggerRef.current) { event.preventDefault(); triggerRef.current.focus() } }
  return <>
    {trigger && <Button ref={triggerRef} variant={triggerVariant ?? (compact ? 'outline' : 'default')} aria-label={triggerLabel} size={compact ? 'sm' : 'default'} disabled={!!disabledReason} aria-describedby={disabledReason ? reasonId : undefined} onClick={() => changeOpen(true)}>{triggerIcon === 'edit' ? <Pencil aria-hidden="true" className="size-4" /> : triggerIcon === 'delete' ? <Trash2 aria-hidden="true" className="size-4" /> : !compact && !destructive && <Plus className="mr-2 h-4 w-4" />}{trigger}</Button>}
    {disabledReason && <span id={reasonId} className="wb-disabled-reason">{disabledReason}</span>}
    {open && <MutationSession close={() => changeOpen(false)} cancelLabel={cancelLabel} confirming={destructive}>{session => {
      const body = <div ref={content}>{children({ close: session.complete, submissionKey: session.submissionKey })}</div>
      const confirm = () => content.current?.querySelector('form')?.requestSubmit()
      if (deleteTarget) return <DeleteDialog {...deleteTarget} title={title} open onOpenChange={changeOpen} onCloseAutoFocus={restoreFocus} cancelText={cancelLabel} isDeleting={session.pending} pendingText={labels.saving} onConfirm={confirm}>{body}</DeleteDialog>
      if (destructive) return <ConfirmDialog open title={title} description={description} cancelText={cancelLabel} confirmText={title} confirmVariant="destructive" isConfirming={session.pending} pendingText={labels.saving} onOpenChange={changeOpen} onCloseAutoFocus={restoreFocus} onConfirm={confirm}>{body}</ConfirmDialog>
      return <FormDialog open maxWidth={maxWidth} title={title} description={description} closeLabel={labels.close} formState={{ isDirty: session.dirty, isSubmitting: session.pending }} onReset={session.reset} closeRequest={session.closeRequest} onContinueEditing={session.continueEditing} onOpenChange={changeOpen} onCloseAutoFocus={restoreFocus} onOpenAutoFocus={event => { event.preventDefault(); [...(content.current?.querySelectorAll<HTMLElement>('input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled)') ?? [])].find(node => !node.closest('[hidden], [aria-hidden="true"]') && node.tabIndex >= 0)?.focus() }} discardPrompt={{ title: labels.discardTitle, message: labels.discardMessage, discardLabel: labels.discard, continueLabel: labels.continueEditing }}>{body}</FormDialog>
    }}</MutationSession>}
  </>
}
