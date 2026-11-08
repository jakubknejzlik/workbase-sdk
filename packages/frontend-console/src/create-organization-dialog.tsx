import { useRef, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button, CreateWorkspaceModal, Form, FormFieldInput, MutationSession, MutationSubmitButton, MutationErrorAlert, useMutationLabels, useMutationSession, useMutationForm, useMutationSubmit } from '@workbasehq/ui'
import { api, ApiError } from './api/client'
import { validProfileName } from './api/profile'

export function CreateOrganizationDialog({ open: controlledOpen, onOpenChange, trigger, onCloseAutoFocus, retainActive = false }: {
  open?: boolean; onOpenChange?: (open: boolean) => void; trigger?: string; onCloseAutoFocus?: (event: Event) => void; retainActive?: boolean
}) {
  const { t } = useTranslation(); const labels = useMutationLabels(); const [internalOpen, setOpen] = useState(false); const triggerRef = useRef<HTMLButtonElement>(null)
  const open = controlledOpen ?? internalOpen
  const changeOpen = (next: boolean) => { setOpen(next); onOpenChange?.(next) }
  return <>
    {trigger && <Button ref={triggerRef} onClick={() => changeOpen(true)}>{trigger}</Button>}
    {open && <MutationSession close={() => changeOpen(false)} cancelLabel={t('cancel')}>{session => <CreateOrganizationForm retainActive={retainActive} render={form => <CreateWorkspaceModal dialog={{
      open: true, onOpenChange: changeOpen, closeLabel: labels.close, discardPrompt: { title: labels.discardTitle, message: labels.discardMessage, discardLabel: labels.discard, continueLabel: labels.continueEditing }, title: t('createOrganization'), description: t('createDescription'),
      formState: { isDirty: session.dirty, isSubmitting: session.pending }, onReset: session.reset, closeRequest: session.closeRequest, onContinueEditing: session.continueEditing,
      onCloseAutoFocus: event => { onCloseAutoFocus?.(event); if (!event.defaultPrevented && triggerRef.current) { event.preventDefault(); triggerRef.current.focus() } },
    }}>{form}</CreateWorkspaceModal>} />}</MutationSession>}
  </>
}

/** The setup Card and Add dialog share P4 fields and the P1 mutation lifecycle. */
export function CreateOrganizationForm({ retainActive = false, setup = false, render = form => form, children }: { retainActive?: boolean; setup?: boolean; render?: (form: ReactNode) => ReactNode; children?: (busy: boolean) => ReactNode }) {
  const { t } = useTranslation(); const navigate = useNavigate(); const client = useQueryClient()
  const submit = useMutationSubmit(); const session = useMutationSession()!
  const form = useMutationForm({ defaultValues: { name: '' } })
  const create = useMutation({ mutationFn: (name: string) => api<{ id: string }>('/orgs', { method: 'POST', body: { name } }), onSuccess: async org => {
    // Bootstrap also seeds Me, so discard its pre-creation membership snapshots.
    client.removeQueries({ queryKey: ['bootstrap'], type: 'inactive' })
    await Promise.all([client.invalidateQueries({ queryKey: ['me'] }), client.invalidateQueries({ queryKey: ['bootstrap'], refetchType: 'none' }), client.invalidateQueries({ queryKey: ['invitation-inbox'] })])
    form.reset(); session.complete()
    if (!retainActive) await navigate({ to: '/o/$orgId', params: { orgId: org.id } })
  } })
  const busy = create.isPending || session.pending
  const errorKey = create.error instanceof ApiError && create.error.code === 'account_already_assigned' ? 'accountAlreadyAssigned' : create.error instanceof ApiError && create.error.status === 400 ? 'invalidName' : create.error instanceof ApiError && create.error.status === 403 ? 'forbidden' : 'createFailed'
  const body = <Form form={form} className="w-full" pending={busy} onSubmit={data => submit(() => create.mutateAsync(data.name.trim()))}>
    <div className={setup ? 'space-y-4' : 'grid gap-4 py-4'}>
      <FormFieldInput name="name" label={t('organizationName')} placeholder={t('organizationNamePlaceholder')} required autoFocus disabled={busy} rules={{ validate: value => validProfileName(String(value)) || t('invalidName') }} />
      <MutationErrorAlert isError={create.isError} error={create.error} fallbackMessage={t(errorKey)} />
      {setup && <MutationSubmitButton footer={false} pending={busy} type="submit" className="w-full">{t('p2CompleteSetup')}</MutationSubmitButton>}
    </div>
    {!setup && <MutationSubmitButton pending={busy} type="submit">{t('create')}</MutationSubmitButton>}
    {children?.(busy)}
  </Form>
  return render(body)
}
