import { useEffect, useRef, useState, type ComponentProps } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Copy, Key, Trash2 } from 'lucide-react'
import { APITokensSettings, ActionDialog, Button, ConfirmDialog, Form, FormFieldInput, FormFieldWrapper, MutationErrorAlert, MutationLabelsProvider, MutationSession, MutationSubmitButton, useMutationForm, useMutationLabels, useMutationSession, useMutationSubmit } from '@workbasehq/ui'
import { Badge } from '@workbasehq/ui/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workbasehq/ui/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@workbasehq/ui/components/ui/dialog'
import { ApiError } from './api/client'
import { instanceOptions } from './api/identity'
import { tokenClient, tokenKey, useTokenAction, useTokens, type AgentToken } from './api/tokens'
import { Loading, QueryError } from './screens'

function tokenError(error: unknown) {
  if (!(error instanceof ApiError)) return 'tokenFailed'
  return error.status === 403 ? 'tokenDenied' : error.status === 409 ? 'tokenConflict' : error.status === 400 ? 'tokenInvalid' : 'tokenFailed'
}
export function TokensSettings({ orgId }: { orgId: string }) {
  const { t, i18n } = useTranslation(); const access = useTokens(orgId); const schema = useQuery(instanceOptions); const client = useQueryClient(); const authorize = useTokenAction(orgId)
  const location = useRouterState({ select: state => state.location.href })
  const [creating, setCreating] = useState(false); const [created, setCreated] = useState<{ name: string; secret: string } | null>(null)
  const handoff = useRef(false)
  const [target, setTarget] = useState<AgentToken | null>(null); const trigger = useRef<HTMLButtonElement>(null); const revokeTrigger = useRef<HTMLButtonElement | null>(null)
  const refresh = () => client.invalidateQueries({ queryKey: tokenKey(orgId) })
  useEffect(() => { setCreated(null) }, [location, orgId])
  useEffect(() => { if (!access.allowed) { setCreated(null); setCreating(false) } }, [access.allowed])
  const revoke = useMutation({ gcTime: 0, mutationFn: async () => { if (target) await authorize('tokens.revoke', () => tokenClient.revoke(orgId, target.id)) }, onSuccess: async () => { setTarget(null); await refresh() } })
  if (access.capabilities.isPending) return <Loading />
  if (access.capabilities.error) return <QueryError error={access.capabilities.error} />
  if (!access.allowed) return <div className="space-y-2"><h1 tabIndex={-1} className="text-lg font-medium">{t('tokens')}</h1><p role="alert">{t('tokenDenied')}</p></div>
  if (access.list.error) return <QueryError error={access.list.error} />
  if (schema.error) return <QueryError error={schema.error} />
  const date = (value: string | null, fallback = 'unavailable', relative = true) => {
    if (!value) return t(fallback)
    const exact = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
    const seconds = (Date.parse(value) - Date.now()) / 1000
    const units = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]] as const
    const [unit, size] = units.find(([, size]) => Math.abs(seconds) >= size) ?? units[units.length - 1]
    return <time dateTime={value} title={exact}>{relative ? new Intl.RelativeTimeFormat(i18n.language, { numeric: 'auto' }).format(Math.round(seconds / size), unit) : exact}</time>
  }
  const role = (value: string) => t(`role_${value}`, { defaultValue: value })
  const grants = access.capabilities.data.resources ?? {}
  return <>
    <APITokensSettings title={t('tokens')} description={t('tokenDescription')} empty={t('tokenEmpty')} loading={access.list.isPending ? t('loading') : undefined}
      create={grants['tokens.create'] && <Button ref={trigger} onClick={() => { handoff.current = false; setCreating(true) }}><Key className="mr-2 size-4" aria-hidden="true" />{t('createToken')}</Button>}
      columns={[
        { label: t('tokenName'), className: 'max-md:col-start-1 max-md:row-start-1' },
        { label: t('tokenCreatedBy'), className: 'max-md:col-span-2 max-md:row-start-3', mobileLabel: true },
        { label: t('tokenCreatedAt'), className: 'hidden md:table-cell' },
        { label: t('lastUse'), className: 'hidden md:table-cell' },
        { label: t('tokenAccess'), className: 'max-md:col-span-2 max-md:row-start-4' },
        { label: t('status'), className: 'max-md:col-start-1 max-md:row-start-2' },
        { label: t('actions'), className: 'max-md:col-start-2 max-md:row-start-1 max-md:row-span-2' },
      ]}
      rows={(access.list.data?.data ?? []).map(row => ({ id: row.id, cells: [
        <div className="max-w-48 break-words whitespace-normal"><div>{row.name}</div><code className="text-xs text-muted-foreground">{row.prefix}</code></div>,
        <div className="max-w-40 whitespace-normal break-words">{row.issuer?.display_name ?? t('tokenIssuerUnavailable')}{!row.issuer_active && <p className="mt-1 text-xs text-muted-foreground">{t('tokenIssuerInactive')}</p>}</div>,
        date(row.created_at), date(row.last_used_at, 'tokenNever'),
        <div className="max-w-56 space-y-1 whitespace-normal break-words"><Badge variant="outline" className="hidden md:inline-flex">{role(row.role)}</Badge><p className="hidden text-xs text-muted-foreground md:block">{row.operations === null ? t('allRoleOperations') : row.operations.length ? row.operations.join(', ') : t('noOperations')}</p><p className="text-xs">{t('expiry')}: {date(row.expires_at, 'unavailable', false)}</p></div>,
        <Badge variant={row.revoked_at || Date.parse(row.expires_at) <= Date.now() || !row.issuer_active ? 'secondary' : 'default'}>{t(row.revoked_at ? 'revoked' : Date.parse(row.expires_at) <= Date.now() ? 'expired' : !row.issuer_active ? 'tokenInactive' : 'active')}</Badge>,
        grants['tokens.revoke'] && <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" aria-label={t('tokenRevokeNamed', { name: row.name })} disabled={!!row.revoked_at} onClick={event => { revokeTrigger.current = event.currentTarget; revoke.reset(); setTarget(row) }}><Trash2 className="size-4" aria-hidden="true" /></Button>,
      ] }))} />
    {creating && <ActionDialog open onOpenChange={setCreating} title={t('createToken')} description={t('createTokenDescription')} cancelLabel={t('cancel')} onCloseAutoFocus={event => { event.preventDefault(); if (!handoff.current) trigger.current?.focus() }}>{({ close }) => <TokenCreate orgId={orgId} roles={schema.data?.roles ?? []} onCreated={(name, secret) => { handoff.current = true; setCreated({ name, secret }); close() }} />}</ActionDialog>}
    {created && <TokenCreated name={created.name} secret={created.secret} close={() => setCreated(null)} restoreFocus={event => { event.preventDefault(); trigger.current?.focus() }} />}
    {target && <MutationSession close={() => setTarget(null)} cancelLabel={t('cancel')} confirming>{session => <ConfirmDialog open onOpenChange={open => { if (!open) setTarget(null) }} title={t('revokeToken')} description={t('tokenRevokeDescription', { name: target?.name })} confirmText={t('revokeToken')} cancelText={t('cancel')} confirmVariant="destructive" isConfirming={session.pending || revoke.isPending} pendingText={t('tokenRevoking')} onConfirm={() => session.run(() => revoke.mutateAsync())} onCloseAutoFocus={event => { event.preventDefault(); revokeTrigger.current?.focus() }}>
      <MutationErrorAlert isError={revoke.isError} error={revoke.error} fallbackMessage={t(tokenError(revoke.error))} />
    </ConfirmDialog>}</MutationSession>}
  </>
}
interface CreateFields { name: string; role: string; expiry: string; restricted: boolean; operations: string }
function TokenCreate({ orgId, roles, onCreated }: { orgId: string; roles: string[]; onCreated: (name: string, secret: string) => void }) {
  const { t } = useTranslation(); const labels = useMutationLabels(); const client = useQueryClient(); const authorize = useTokenAction(orgId); const submit = useMutationSubmit(); const session = useMutationSession()!
  const alive = useRef(true); useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const form = useMutationForm<CreateFields>({ defaultValues: { name: '', role: '', expiry: '', restricted: false, operations: '' } })
  // Return void and collect immediately. Only mounted local state receives the secret.
  const create = useMutation({ gcTime: 0, mutationFn: async (data: CreateFields) => {
    await authorize('tokens.create', async () => {
      const result = await tokenClient.create(orgId, { name: data.name.trim(), role: data.role, ...(data.expiry ? { expires_at: new Date(data.expiry).toISOString() } : {}), ...(data.restricted ? { operations: data.operations.split(/[\s,]+/).filter(Boolean) } : {}) })
      if (alive.current) onCreated(data.name.trim(), result.token)
      void client.invalidateQueries({ queryKey: tokenKey(orgId) })
    })
  } })
  const busy = session.pending || create.isPending
  return <MutationLabelsProvider value={{ ...labels, saving: t('tokenCreating') }}><Form form={form} pending={busy} className="space-y-4" onSubmit={data => submit(() => create.mutateAsync(data))}>
    <FormFieldInput name="name" label={t('tokenName')} placeholder={t('tokenNamePlaceholder')} maxLength={200} disabled={busy} rules={{ validate: value => !!String(value).trim() || t('tokenNameRequired') }} />
    <FormFieldWrapper name="role" label={t('role')} rules={{ required: t('chooseRole') }}>{field => <TokenRoleSelect roles={roles} value={field.value} onValueChange={field.onChange} disabled={busy} ref={field.ref} onBlur={field.onBlur} />}</FormFieldWrapper>
    <FormFieldInput name="expiry" label={t('optionalExpiry')} type="datetime-local" disabled={busy} rules={{ validate: value => !value || (Date.parse(String(value)) > Date.now() && Date.parse(String(value)) <= Date.now() + 365 * 86400000) || t('tokenExpiryInvalid') }} />
    <FormFieldWrapper name="restricted" label={t('restrictOperations')}>{field => <input type="checkbox" className="size-4" ref={field.ref} checked={field.value} onChange={field.onChange} onBlur={field.onBlur} disabled={busy} />}</FormFieldWrapper>
    {form.watch('restricted') && <FormFieldInput name="operations" label={t('operations')} description={t('operationsHint')} disabled={busy} rules={{ validate: value => { const operations = String(value).split(/[\s,]+/).filter(Boolean); return operations.length <= 100 && operations.every(operation => /^[a-z][a-z0-9_]*(?:[/.][a-z][a-z0-9_]*)+$/.test(operation)) || t('tokenInvalid') } }} />}
    <MutationErrorAlert isError={create.isError} error={create.error} fallbackMessage={t(tokenError(create.error))} />
    <MutationSubmitButton type="submit" pending={busy}>{t('createToken')}</MutationSubmitButton>
  </Form></MutationLabelsProvider>
}
function TokenRoleSelect({ roles, value, onValueChange, ...control }: ComponentProps<typeof SelectTrigger> & { roles: string[]; value: string; onValueChange: (value: string) => void }) {
  const { t } = useTranslation()
  return <Select value={value} onValueChange={onValueChange} disabled={control.disabled}><SelectTrigger {...control} className="w-full"><SelectValue placeholder={t('chooseRole')} /></SelectTrigger><SelectContent>{roles.map(role => <SelectItem key={role} value={role}>{t(`role_${role}`, { defaultValue: role })}</SelectItem>)}</SelectContent></Select>
}
function TokenCreated({ name, secret, close, restoreFocus }: { name: string; secret: string; close: () => void; restoreFocus: (event: Event) => void }) {
  const { t } = useTranslation(); const [copied, setCopied] = useState(false); const [copyFailed, setCopyFailed] = useState(false); const copy = useRef<HTMLButtonElement>(null)
  return <Dialog open onOpenChange={open => { if (!open) close() }}><DialogContent closeLabel={t('close')} onCloseAutoFocus={restoreFocus} onOpenAutoFocus={event => { event.preventDefault(); copy.current?.focus() }}>
    <DialogHeader><DialogTitle>{t('tokenCreatedTitle')}</DialogTitle><DialogDescription>{t('tokenOnce')}</DialogDescription></DialogHeader>
    <p className="break-words font-medium">{name}</p><pre className="whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-sm" aria-label={t('rawToken')}>{secret}</pre>
    <Button ref={copy} className="w-full" onClick={async () => { try { await navigator.clipboard.writeText(secret); setCopied(true); setCopyFailed(false) } catch { setCopied(false); setCopyFailed(true) } }}><Copy className="mr-2 size-4" aria-hidden="true" />{t('copyToken')}</Button>
    {copied && <p role="status">{t('tokenCopied')}</p>}{copyFailed && <p role="alert" className="text-sm text-destructive">{t('copyFailed')}</p>}
    <DialogFooter><Button variant="secondary" onClick={close}>{t('tokenDone')}</Button></DialogFooter>
  </DialogContent></Dialog>
}
