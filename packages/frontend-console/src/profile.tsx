import { Languages } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Form, FormFieldInput, UserSettings, UserOnboarding, MutationSession, MutationSubmitButton, MutationErrorAlert, ConfirmDialog, useMutationForm, useMutationSubmit, useMutationSession, useMutationLabels, Button } from '@workbasehq/ui'
import { profileClient, profileOptions, validProfileName, settingsError, type SelfProfile } from './api/profile'
import { Loading, QueryError } from './screens'
import { api } from './api/client'

/** P1 owns dirty navigation, duplicate submit and pending state for page forms too. */
export function SettingsMutation({ children }: { children: ReactNode }) {
  const { t } = useTranslation(); const labels = useMutationLabels(); const [handled, setHandled] = useState(0)
  return <MutationSession close={() => {}} cancelLabel={t('cancel')}>{session => <>
    {children}
    <ConfirmDialog open={session.closeRequest > handled} title={labels.discardTitle} description={labels.discardMessage} confirmText={labels.discard} cancelText={labels.continueEditing} confirmVariant="destructive"
      onConfirm={() => { session.reset(); setHandled(session.closeRequest) }} onOpenChange={open => { if (!open) { session.continueEditing(); setHandled(session.closeRequest) } }} />
  </>}</MutationSession>
}

export function ProfileGate({ children }: { children: ReactNode }) {
  const profile = useQuery(profileOptions)
  if (profile.isPending) return <main id="main"><Loading /></main>
  if (profile.error) return <main id="main"><QueryError error={profile.error} /></main>
  if (!profile.data.completeness.complete) return <main id="main"><ProfileEditor profile={profile.data} setup /></main>
  return children
}

export function ProfileSettings() {
  const profile = useQuery(profileOptions)
  if (profile.isPending) return <Loading />
  if (profile.error) return <QueryError error={profile.error} />
  return <ProfileEditor profile={profile.data} />
}
export function ProfileEditor({ profile, setup = false }: { profile: SelfProfile; setup?: boolean }) {
  return <SettingsMutation key={`${profile.id}-${setup}`}><ProfileForm profile={profile} setup={setup} /></SettingsMutation>
}
function ProfileForm({ profile, setup }: { profile: SelfProfile; setup: boolean }) {
  const { t, i18n } = useTranslation(); const client = useQueryClient(); const session = useMutationSession()!; const submit = useMutationSubmit()
  const logout = useMutation({ mutationFn: () => api('/auth/logout', { method: 'POST' }), onSuccess: () => { client.clear(); window.location.assign('/sign-in') } })
  useEffect(() => { document.querySelector<HTMLElement>('h1')?.focus() }, [])
  const form = useMutationForm({ defaultValues: { firstName: profile.firstName ?? '', lastName: profile.lastName ?? '', email: profile.email } })
  const editable = profile.authority.kind === 'local' && profile.capabilities.canEditNames
  useEffect(() => {
    if (!editable) form.reset({ firstName: profile.firstName ?? '', lastName: profile.lastName ?? '', email: profile.email })
  }, [profile.firstName, profile.lastName, profile.email, editable])
  const save = useMutation({ mutationFn: async (names: { firstName: string; lastName: string }) => {
    const result = await profileClient.update(names)
    form.reset({ firstName: result.firstName ?? '', lastName: result.lastName ?? '', email: result.email })
    if (setup && result.completeness.complete) session.complete()
    client.setQueryData(profileOptions.queryKey, result)
    if (setup && result.completeness.complete) await client.invalidateQueries({ queryKey: ['bootstrap'] })
    await client.invalidateQueries({ queryKey: ['me'] })
  } })
  const busy = session.pending || save.isPending || logout.isPending
  const field = (name: 'firstName' | 'lastName') => <FormFieldInput name={name} label={t(name)} autoComplete={name === 'firstName' ? 'given-name' : 'family-name'} required disabled={!editable || busy} rules={{ validate: value => validProfileName(String(value)) || t('invalidName') }} />
  const email = <FormFieldInput name="email" label={t('email')} type="email" autoComplete="email" disabled />
  const notice = !editable && <div className="space-y-2"><p role="status" className="text-sm text-muted-foreground">{t('profileManaged')}</p>{setup && <><p className="text-sm">{t('profileManagedIncomplete')}</p><Button type="button" variant="outline" disabled={busy} onClick={() => void client.invalidateQueries({ queryKey: profileOptions.queryKey })}>{t('profileRefresh')}</Button></>}</div>
  const error = <MutationErrorAlert isError={save.isError} error={save.error} fallbackMessage={t(settingsError(save.error))} />
  const footer = editable && <MutationSubmitButton footer={false} type="submit" pending={busy} disabled={!form.formState.isDirty} className={setup ? 'w-full' : undefined}>{t(setup ? 'profileContinue' : 'saveChanges')}</MutationSubmitButton>
  const content = setup ? <div className="flex flex-col gap-4">{notice}{error}{email}{field('firstName')}{field('lastName')}{footer}</div> : <UserSettings title={t('profileSettings')} description={t('profileDescription')} email={email} firstName={field('firstName')} lastName={field('lastName')} notice={notice} error={error} footer={footer} />
  const body = <Form form={form} className="w-full" pending={busy} onSubmit={data => editable && !busy ? submit(() => save.mutateAsync({ firstName: data.firstName.trim(), lastName: data.lastName.trim() })) : Promise.resolve()}>{content}</Form>
  return setup ? <UserOnboarding title={t('profileSetupTitle')} description={t(editable ? 'profileSetupDescription' : 'profileManagedSetupDescription')}><div className="w-full space-y-4">
    {body}
    {logout.error && <p role="alert" className="text-sm text-destructive">{t('requestFailed')}</p>}
    <div className="flex items-center justify-between gap-2 border-t pt-4">
      <Button type="button" variant="ghost" aria-label={t('switchLanguage')} disabled={busy} onClick={() => { const language = i18n.language === 'cs' ? 'en' : 'cs'; void i18n.changeLanguage(language); document.documentElement.lang = language }}><Languages />{t('languageLabel')}</Button>
      <Button type="button" variant="outline" disabled={busy} onClick={() => void submit(() => logout.mutateAsync())}>{t('signOut')}</Button>
    </div>
  </div></UserOnboarding> : body
}
