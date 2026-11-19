import { hasRecordAccess } from './account-link'
import type { RowAccessStatus } from '../../core/src/row-access'
import { Card, CardHeader, CardTitle, CardContent } from '@workbasehq/ui/components/ui/card'
import { Form as FormProvider } from '@workbasehq/ui/components/ui/form'
import { Input } from '@workbasehq/ui/components/ui/input'
import { Badge } from '@workbasehq/ui/components/ui/badge'
import { editableManyRelations, memberships, syncMemberships } from './many-to-many'
import { ManyRelationField } from './many-relation-field'
import type { ComponentProps, ReactNode } from 'react'
import { createDataTableQueryKey } from '@workbasehq/ui'
import { useEffect, useRef, useState } from 'react'
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useReferenceAuthority } from './reference-authority'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { useEntityTranslation } from './entity-translation'
import { SchemaFormDialog, DeleteActionDialog, Button, EntityPicker, RegistryForm, formValidator, FormFieldWrapper, useMutationForm, MutationLabelsProvider, useMutationLabels, MutationSubmitButton, MutationErrorAlert, RowActions, useMutationSubmit, type RegistrySchema } from '@workbasehq/ui'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@workbasehq/ui/components/ui/dropdown-menu'
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from '@workbasehq/ui/components/ui/tooltip'
import { recordLabel, formatFieldValue, readQuery, visibleEntities, type Capabilities, type Model, type ReadQuery, type Result } from './read'
import { commandError, commandLabel, commandFormSchema, writeCodes as codes, commandDefinitions, commandRowField, listCommandActions, writableFields, writeSchema, inlineEditableField } from './write'
import { usePickerSearch } from './use-picker-search'
import { selectedReferenceRow, useSelectedReferences } from './use-selected-references'
import { breadcrumbRecordLabel, usePublishRecordBreadcrumb } from './breadcrumbs'
export type WriteRequest = (path: string, method: string, body?: unknown, key?: string) => Promise<any>
interface Context { initialValues?: Record<string, string>; lockedValues?: Record<string, string>; onDenied?: () => void; model: Model; caps: Capabilities; orgId: string; entity: string; request: (query: ReadQuery) => Promise<Result>; write: WriteRequest }
interface WriteFailure { code?: string; status?: number; details?: { field?: unknown; path?: unknown; paths?: unknown } }
function writeErrorKey(error: unknown) {
  const failure = error as WriteFailure | null
  if (!failure) return null
  if (failure.code === 'invitation_delivery_failed') return 'rowInviteDeliveryFailed'
  // Closed write codes describe a refused mutation, even with HTTP 403.
  return failure.status === 404 ? 'notFoundDescription' : codes.includes(failure.code ?? '') ? `write_${failure.code}` : failure.status === 403 ? 'forbiddenDescription' : 'requestFailed'
}
function writeFieldErrors(error: unknown, schema?: RegistrySchema): Record<string, string> {
  const failure = error as WriteFailure | null; const key = writeErrorKey(error)
  if (!schema || !failure || !codes.includes(failure.code ?? '') || !key) return {}
  if (failure.status === 409 && failure.code === 'account_already_linked' && Object.hasOwn(schema.properties ?? {}, 'user_id')) return { user_id: key }
  const details = failure.details
  const paths = Array.isArray(details?.paths) ? details.paths : []
  const names = [details?.field, ...(Array.isArray(details?.path) ? [details.path[0]] : []), ...paths.map(path => Array.isArray(path) ? path[0] : undefined)]
  // Match only actual writable fields; never render server messages or unknown paths.
  return Object.fromEntries(names.filter((name): name is string => typeof name === 'string' && Object.hasOwn(schema.properties ?? {}, name)).map(name => [name, key]))
}
function WriteError({ error, schema, command = false, context }: { error: unknown; schema?: RegistrySchema; command?: boolean; context?: string }) {
  const { t } = useTranslation(); const key = error && command ? commandError(error as WriteFailure).key : writeErrorKey(error)
  if (!key || Object.keys(writeFieldErrors(error, schema)).length) return null
  return <MutationErrorAlert isError error={error} fallbackMessage={t(key, { context })} />
}
function translatedFieldErrors(error: unknown, schema: RegistrySchema, t: (key: string) => string) {
  return Object.fromEntries(Object.entries(writeFieldErrors(error, schema)).map(([field, key]) => [field, t(key)]))
}
function entityObjectName(entity: string, t: (key: string, options?: any) => string) {
  return t(`entityObject_${entity}`, { defaultValue: t(`entitySingular_${entity}`, { defaultValue: t('record') }) })
}
export function resourceCreateLabel(model: Model, entity: string, language: string, t: (key: string, options?: any) => string, caps?: Capabilities) {
  const command = caps && listCommandActions(model, entity, caps).create
  if (command) return commandLabel(command, language, t)
  return t('addEntity', { context: entity, entity: entityObjectName(entity, t) })
}
export function GeneratedCreateDialog(props: Context & { open: boolean; onOpenChange: (open: boolean) => void; onCloseAutoFocus?: (event: Event) => void }) {
  const { t } = useEntityTranslation(props.entity)
  if (!visibleEntities(props.model, props.caps).includes(props.entity)) return null
  const command = listCommandActions(props.model, props.entity, props.caps).create
  if (command) return <CreateCommandDialog {...props} command={command} />
  if (!props.caps.entities[props.entity].operations.includes('create')) return null
  return <ResourceFormDialog entity={props.entity} outcome="created" schema={writeSchema(props.model, props.entity, props.caps)} open={props.open} onOpenChange={props.onOpenChange} onCloseAutoFocus={props.onCloseAutoFocus} title={t('createEntity', { entity: entityObjectName(props.entity, t) })} description={t('createEntityDescription', { entity: entityObjectName(props.entity, t) })} cancelLabel={t('cancel')}>{controls => <EntityMutation {...props} controls={controls} />}</ResourceFormDialog>
}
function CreateCommandDialog({ command, ...props }: Context & { command: NonNullable<Model['commands']>[number]; open?: boolean; onOpenChange?: (open: boolean) => void; onCloseAutoFocus?: (event: Event) => void }) {
  const { t, i18n } = useEntityTranslation(props.entity)
  const label = commandLabel(command, i18n.language, t)
  return <ResourceFormDialog entity={props.entity} outcome="created" schema={commandFormSchema(command.inputSchema)} trigger={props.open === undefined ? label : undefined} open={props.open} onOpenChange={props.onOpenChange} onCloseAutoFocus={props.onCloseAutoFocus} title={label} description={t('commandDescription', { context: command.name.replace('/', '_') })} cancelLabel={t('cancel')}>{controls => <CommandMutation {...props} schema={command.inputSchema} name={command.name} controls={controls} />}</ResourceFormDialog>
}
export function GeneratedActions(props: Context & { row?: Record<string, any> }) {
  const { t, i18n } = useEntityTranslation(props.entity); const { model, caps, entity, row } = props
  if (!visibleEntities(model, caps).includes(entity)) return null
  const operations = caps.entities[entity].operations
  const createLabel = resourceCreateLabel(model, entity, i18n.language, t, caps)
  const createCommand = !row ? listCommandActions(model, entity, caps).create : undefined
  return <div className="wb-write-actions">
    {createCommand && <CreateCommandDialog {...props} command={createCommand} />}
    {(!row ? ['create'] : ['update']).filter(operation => operations.includes(operation) && (operation !== 'update' || caps.entities[entity].readable.includes('version'))).map(operation => <ResourceFormDialog entity={entity} outcome={row ? 'updated' : 'created'} schema={writeSchema(model, entity, caps, row ? 'edit' : 'create')} compact={!!row} key={operation} trigger={operation === 'create' ? createLabel : t('edit', { context: '' })} triggerIcon={row ? 'edit' : undefined} triggerVariant={row ? 'secondary' : undefined} title={t(operation === 'create' ? 'createEntity' : 'editEntity', { entity: operation === 'create' ? entityObjectName(entity, t) : t(`entitySingular_${entity}`) })} description={t(operation === 'create' ? 'createEntityDescription' : 'editEntityDescription', { entity: operation === 'create' ? entityObjectName(entity, t) : t(`entitySingular_${entity}`) })} cancelLabel={t('cancel')}>{controls => <EntityMutation {...props} row={row} controls={controls} />}</ResourceFormDialog>)}
    {row && operations.includes('delete') && <ResourceDeleteDialog entity={entity} entityType={t(`entity_${entity}`, { defaultValue: entity })} entityName={recordLabel(model, entity, row, caps, i18n.language, t)} targetDescription={t('deleteTarget')} warningMessage={t('deleteDescription')} confirmText={t('delete')} compact trigger={t('delete', { context: '' })} triggerIcon="delete" triggerVariant="destructive" title={t('deleteRecord')} description={t('deleteDescription')} cancelLabel={t('cancel')} destructive>{controls => <DeleteMutation {...props} row={row} close={controls.close} />}</ResourceDeleteDialog>}
    {row ? commandDefinitions(model, entity, caps).filter(command => !!commandRowField(command, entity)).map(command => {
      const replacement = command.ui?.replacesCrud
      const label = commandLabel(command, i18n.language, t)
      return <ResourceFormDialog entity={command.permission.entity} outcome={command.name.endsWith('/create') ? 'created' : command.name.endsWith('/delete') ? 'deleted' : undefined} schema={commandFormSchema(command.inputSchema)} compact key={command.name}
        trigger={label} triggerLabel={label}
        triggerIcon={replacement === 'update' ? 'edit' : replacement === 'delete' ? 'delete' : undefined} triggerVariant={replacement === 'update' ? 'secondary' : replacement === 'delete' ? 'destructive' : undefined}
        title={label} description={t('commandDescription', { context: command.name.replace('/', '_') })} cancelLabel={t('cancel')}>{controls => <CommandMutation {...props} schema={command.inputSchema} name={command.name} values={{ [commandRowField(command, entity)!]: row.id }} controls={controls} />}</ResourceFormDialog>
    }) : <HeaderCommands {...props} />}
  </div>
}
export function GeneratedRowActions(props: Context & { row: Record<string, any>; disabled?: boolean }) {
  const { t, i18n } = useEntityTranslation(props.entity); const { model, caps, entity, row } = props
  if (!visibleEntities(model, caps).includes(entity)) return null
  const operations = caps.entities[entity].operations
  const commands = commandDefinitions(model, entity, caps).filter(command => !!commandRowField(command, entity))
  const items = [
    ...(operations.includes('update') && caps.entities[entity].readable.includes('version') ? [{ id: 'edit', label: t('edit') }] : []),
    ...commands.map(command => ({ id: command.name, label: commandLabel(command, i18n.language, t) })),
    ...(operations.includes('delete') ? [{ id: 'delete', label: t('delete'), destructive: true }] : []),
  ]
  return <><RowActions label={t('rowActions', { name: recordLabel(model, entity, row, caps, i18n.language, t) })} items={items} disabled={props.disabled}>{(action, close, restoreFocus) => {
    const common = { open: true, onOpenChange: (open: boolean) => { if (!open) close() }, onCloseAutoFocus: restoreFocus, cancelLabel: t('cancel') }
    if (action.id === 'edit') return <ResourceFormDialog entity={entity} outcome={row ? 'updated' : 'created'} schema={writeSchema(model, entity, caps, 'edit')} {...common} title={t('editEntity', { entity: t(`entitySingular_${entity}`) })} description={t('editEntityDescription', { entity: t(`entitySingular_${entity}`) })}>{controls => <EntityMutation {...props} row={row} controls={controls} />}</ResourceFormDialog>
    if (action.id === 'delete') return <ResourceDeleteDialog entity={entity} {...common} title={t('deleteRecord')} description={t('deleteDescription')} entityType={t(`entity_${entity}`)} entityName={recordLabel(model, entity, row, caps, i18n.language, t)} targetDescription={t('deleteTarget')} warningMessage={t('deleteDescription')} confirmText={t('delete')}>{controls => <DeleteMutation {...props} row={row} close={controls.close} />}</ResourceDeleteDialog>
    const command = commands.find(command => command.name === action.id)!
    return <ResourceFormDialog entity={command.permission.entity} outcome={command.name.endsWith('/create') ? 'created' : command.name.endsWith('/delete') ? 'deleted' : undefined} schema={commandFormSchema(command.inputSchema)} {...common} title={action.label} description={t('commandDescription', { context: command.name.replace('/', '_') })}>{controls => <CommandMutation {...props} schema={command.inputSchema} name={command.name} values={{ [commandRowField(command, entity)!]: row.id }} controls={controls} />}</ResourceFormDialog>
  }}</RowActions></>
}
export function HeaderCommands(props: Context) {
  const { t, i18n } = useEntityTranslation(props.entity)
  const commands = listCommandActions(props.model, props.entity, props.caps).secondary
  const [selected, setSelected] = useState<string>()
  const trigger = useRef<HTMLButtonElement>(null)
  const requested = useRef<string | undefined>(undefined)
  const command = commands.find(command => command.name === selected)
  if (!visibleEntities(props.model, props.caps).includes(props.entity) || !commands.length) return null
  return <>
    {commands.length === 1 ? <Button ref={trigger} variant="outline" onClick={() => setSelected(commands[0].name)}>{commandLabel(commands[0], i18n.language, t)}</Button> : <DropdownMenu><DropdownMenuTrigger asChild><Button ref={trigger} variant="outline">{t('moreActions')}<span className="ml-2" aria-hidden="true">⌄</span></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end" onCloseAutoFocus={event => { if (requested.current) { event.preventDefault(); const name = requested.current; requested.current = undefined; setSelected(name) } }}>
        {commands.map(command => <DropdownMenuItem key={command.name} onSelect={() => { requested.current = command.name }}>{commandLabel(command, i18n.language, t)}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>}
    {command && <ResourceFormDialog entity={command.permission.entity} outcome={command.name.endsWith('/create') ? 'created' : command.name.endsWith('/delete') ? 'deleted' : undefined} schema={commandFormSchema(command.inputSchema)} key={command.name} open onOpenChange={open => { if (!open) setSelected(undefined) }} onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus() }} title={commandLabel(command, i18n.language, t)} description={t('commandDescription', { context: command.name.replace('/', '_') })} cancelLabel={t('cancel')}>{controls => <CommandMutation {...props} schema={command.inputSchema} name={command.name} controls={controls} />}</ResourceFormDialog>}
  </>
}
function useRefresh() {
  const client = useQueryClient()
  return () => Promise.all([client.invalidateQueries({ queryKey: createDataTableQueryKey() }), client.invalidateQueries({ queryKey: ['read'] }), client.invalidateQueries({ queryKey: ['picker'] }), client.invalidateQueries({ queryKey: ['lookup'] }), client.invalidateQueries({ queryKey: ['row-access'] }), client.invalidateQueries({ queryKey: ['row-access-delivery'] }), client.invalidateQueries({ queryKey: ['account-link-members'] })])
}
function formLabel(model: Model, entity: string, name: string, translate: (key: string, options?: any) => string) {
  const section = model.entities[entity].sections?.find(section => `section:${section.id}` === name)
  return section ? translate(section.label, { defaultValue: section.label }) : translate(`field_${name}`)
}
interface InlineField { field: string; label: string; value: ReactNode; refresh: () => Promise<Result> }
function EntityMutation(props: Context & { row?: Record<string, any>; controls: { close: () => void; submissionKey: string }; inline?: InlineField }) {
  const { t, i18n } = useEntityTranslation(props.entity); const { model, caps, entity, row, controls, write, request, inline } = props; const refreshAll = useRefresh(); const actor = useReferenceAuthority()?.actor
  const refresh = inline?.refresh ?? refreshAll
  const [current, setCurrent] = useState(row); const [generation, setGeneration] = useState(0)
  const needsEditRead = !inline && !!row && !!model.entities[entity].detail?.groups
  const editRecord = useQuery({ queryKey: ['read', model.instance, props.orgId, caps, entity, row?.id, 'edit-record'], enabled: needsEditRead, queryFn: () => request(readQuery(model, entity, caps, { id: row!.id, purpose: 'edit' })) })
  const editingRow = current !== row ? current : needsEditRead ? editRecord.data?.data[0] : current
  const orgId = props.orgId
  const client = useQueryClient()
  const accountForm = !inline && !!model.entities[entity].accountLink
  const contactField = ['email', 'contact_email'].find(name => ['string', 'text'].includes(model.entities[entity].fields[name]?.type) && caps.entities[entity].readable.includes(name))
  const [contactEmail, setContactEmail] = useState<string | undefined>(undefined)
  // RegistryForm keeps its initial values across background reads. Seed from
  // that same snapshot; only an actual contact-field edit changes the prefill.
  const contactSeed = useRef<string | undefined>(undefined)
  if (contactSeed.current === undefined && (!needsEditRead || editingRow)) {
    const value = contactField ? props.lockedValues?.[contactField] ?? editingRow?.[contactField] ?? props.initialValues?.[contactField] ?? model.entities[entity].writeSchema?.properties?.[contactField]?.default : ''
    contactSeed.current = typeof value === 'string' ? value : ''
  }
  const liveEmail = contactEmail ?? contactSeed.current ?? ''
  const [inviteNow, setInviteNow] = useState(false)
  const invitationForm = useMutationForm<{ email: string | undefined }>({ defaultValues: { email: undefined } }, false)
  const invitationEmail = invitationForm.watch('email')
  const [savedRow, setSavedRow] = useState<Record<string, any>>()
  const [inviteFailed, setInviteFailed] = useState(false)
  const [versionError, setVersionError] = useState<unknown>()
  const createAccess = useApplicationAccess({ ...props, row: savedRow })
  const email = invitationEmail ?? liveEmail
  const canInviteAtCreate = accountForm && !row && model.entities[entity].rowAccess !== false && (hasRecordAccess(model, entity) ? caps.commands?.includes(`${entity}/access_invite`) : model.entities[entity].rowInvitations && (model.entities[entity].rowAccess ?? true))
  const fullSchema = writeSchema(model, entity, caps, row ? 'edit' : 'create')
  const schema = inline ? { ...fullSchema, properties: { [inline.field]: { ...fullSchema.properties[inline.field], 'x-ui': { ...fullSchema.properties[inline.field]['x-ui'], span: 'full', section: undefined } } }, required: fullSchema.required.filter((name: string) => name === inline.field) } : fullSchema
  const relations = editableManyRelations(model, entity, caps).filter(([name]) => Object.hasOwn(schema.properties, name))
  const initial = useQuery({ queryKey: ['read', model.instance, orgId, caps, entity, row?.id, 'form-memberships', generation], enabled: !!row && !!relations.length, queryFn: async () => Object.fromEntries(await Promise.all(relations.map(async ([name, relation]) => [name, row ? [...new Set((await memberships(model, relation, row.id, request)).map(item => item[relation.through!.field]))] : []]))) })
  const saved = useRef<{ row?: Record<string, any>; fields?: string }>({ row })
  const accessVersion = useRef(false)
  const reconcileVersion = async () => {
    try {
      const result = await request(readQuery(model, entity, caps, { id: saved.current.row!.id, purpose: 'edit' }))
      if (!result.data[0] || result.data[0].version == null) throw { code: 'version_conflict' }
      saved.current.row = { ...(saved.current.row ?? row), version: result.data[0].version }
      accessVersion.current = true
      setVersionError(undefined)
    } catch (error) { setVersionError(error); throw error }
  }
  const mutation = useMutation({ mutationKey: accountForm ? ['account-access', orgId, entity] : undefined, mutationFn: async (data: Record<string, any>) => {
    if (versionError) throw versionError
    if (savedRow && createAccess.blocked) throw { code: 'action_unavailable' }
    const fields = Object.fromEntries(Object.entries({ ...data, ...props.lockedValues }).filter(([name]) => !relations.some(([key]) => key === name)))
    const fingerprint = JSON.stringify(fields)
    if (!saved.current.row || Object.keys(fields).length && saved.current.fields !== fingerprint) {
      const parent = saved.current.fields || accessVersion.current ? saved.current.row : editingRow ?? saved.current.row
      saved.current.row = await write(`/api/${entity}${parent ? `/${encodeURIComponent(parent.id)}` : ''}`, parent ? 'PATCH' : 'POST', { ...fields, ...(parent ? { version: parent.version } : {}) }, parent ? undefined : controls.submissionKey)
      saved.current.fields = fingerprint
    }
    try {
      for (const [name, relation] of relations) if (Object.hasOwn(data, name)) await syncMemberships(model, relation, saved.current.row!.id, data[name] ?? [], request, write)
    } catch (cause) {
      // Expose the partial save immediately; slow cache reads cannot hold the error or retry hostage.
      void refresh()
      throw Object.assign(new Error('relation_save_failed', { cause }), { code: 'relation_save_failed' })
    }
    if (canInviteAtCreate && inviteNow) {
      const accessProps = { ...props, row: saved.current.row! }
      setSavedRow(saved.current.row)
      try {
        // Always establish live status after saving, including before a retry.
        const status = await client.fetchQuery({ ...accessQuery(accessProps, actor), staleTime: 0 })
        if (!accessGuard(status).valid) throw { code: 'action_unavailable' }
        // An uncertain prior response may already have created the invitation.
        if (status.state !== 'invited') {
          if (!status.can_invite) throw { code: 'action_unavailable' }
          await inviteRecord(accessProps, email)
        }
        setInviteFailed(false)
      } catch (error) {
        setInviteFailed(true)
        void refresh()
        throw error
      }
    }
  }, onSuccess: async () => { await refresh(); controls.close() }, onError: async (error: WriteFailure) => {
    if (error.status === 403 && !codes.includes(error.code ?? '')) props.onDenied?.()
    // Keep the refused draft frozen, but immediately show the current detail value.
    if (inline && error.code === 'version_conflict') await inline.refresh().catch(() => {})
  } })
  const reload = useMutation({ mutationFn: () => inline ? inline.refresh() : request(readQuery(model, entity, caps, { id: (current ?? saved.current.row)!.id, purpose: 'edit' })), onSuccess: result => { if (!result.data[0]) return; setCurrent(result.data[0]); setContactEmail(undefined); contactSeed.current = undefined; saved.current = { row: result.data[0] }; setGeneration(value => value + 1); mutation.reset() } })
  const breadcrumbDenied = !visibleEntities(model, caps).includes(entity) || [403, 404].includes((mutation.error as WriteFailure | null)?.status ?? 0) || !!reload.error
  usePublishRecordBreadcrumb(!inline && row && current ? { orgId, entity, id: String(current.id), status: breadcrumbDenied ? 'unavailable' : 'ready', label: breadcrumbDenied ? undefined : breadcrumbRecordLabel(model, entity, current, caps, i18n.language, t) } : undefined, 'edit')
  const conflict = (mutation.error as { code?: string } | null)?.code === 'version_conflict'
  const values = Object.fromEntries(writableFields(model, entity, caps).filter(field => editingRow?.[field] !== undefined).map(field => [field, editingRow![field]]))
  if (needsEditRead && editRecord.isPending || row && relations.length && initial.isPending) return <p role="status">{t('loading')}</p>
  if (needsEditRead && (editRecord.error && !editRecord.data || !editingRow)) return <><WriteError error={editRecord.error ?? { code: 'entity_not_found' }} /><Button onClick={() => { void editRecord.refetch() }}>{t('reloadRetry')}</Button></>
  if (initial.error && !initial.data) return <><WriteError error={initial.error} /><Button onClick={() => { void initial.refetch() }}>{t('reloadRetry')}</Button></>
  return <><WriteError error={mutation.error ?? reload.error ?? versionError ?? editRecord.error ?? initial.error} schema={schema} />
    {versionError != null && <Button type="button" onClick={() => { void reconcileVersion().catch(() => {}) }}>{t('reloadRetry')}</Button>}
    {canInviteAtCreate && <fieldset disabled={mutation.isPending || !!savedRow && createAccess.blocked} className="mb-4 space-y-4">
      <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={inviteNow} onChange={event => { setInviteNow(event.target.checked); invitationForm.clearErrors('email') }} /> {t('rowInviteNow')}</label>
      {inviteNow && <FormProvider {...invitationForm}><FormFieldWrapper name="email" label={t('rowInviteEmail')}>{field => <Input {...field} type="email" value={email} onChange={event => { field.onChange(event); invitationForm.clearErrors('email') }} />}</FormFieldWrapper></FormProvider>}
    </fieldset>}
    {inviteFailed && (mutation.error as WriteFailure)?.code !== 'invitation_delivery_failed' && <p role="alert">{t('rowInviteSavedFailed')}</p>}
    {accountForm && (row || savedRow) && <ApplicationAccessCard {...props} row={row ?? savedRow!} email={liveEmail} onChanged={reconcileVersion} />}

    {conflict && inline && <p role="status">{t('inlineFreshValue')}: {inline.value}</p>}
    {conflict && <Button type="button" disabled={reload.isPending} onClick={() => reload.mutate()}>{t('reloadRetry')}</Button>}
    <div onChange={event => {
      const input = event.target as HTMLInputElement
      if (contactField && input.closest('[data-write-field]')?.getAttribute('data-write-field') === contactField) setContactEmail(input.value)
    }}><RegistryForm secondaryAction={inline && <Button data-inline-cancel type="button" variant="outline" disabled={mutation.isPending || reload.isPending} onClick={controls.close}>{t('cancel')}</Button>} optionLabel={value => t(`value_${value}`, { defaultValue: value })} key={generation} requireDirty={!!current} partial={!!current} schema={schema} lockedValues={props.lockedValues} values={{ ...props.initialValues, ...values, ...initial.data }} label={name => inline?.label ?? formLabel(model, entity, name, t)} submitLabel={inviteFailed ? t('rowInviteRetry') : inline ? t('save', { context: '' }) : t(current ? 'save' : 'create')} invalidLabel={t('invalidField')} pending={mutation.isPending || reload.isPending} disabled={conflict || versionError != null || !!savedRow && createAccess.blocked} serverErrors={translatedFieldErrors(mutation.error, schema, t)} onSubmit={data => {
      if (canInviteAtCreate && inviteNow && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        invitationForm.setError('email', { type: 'validate', message: t('rowInviteEmailInvalid') }, { shouldFocus: true })
        return Promise.reject({ code: 'validation_failed' })
      }
      return mutation.mutateAsync(data)
    }} relation={(name, value, change, error) => {
      const relation = relations.find(([key]) => key === name)?.[1]
      if (relation?.through) return <ManyRelationField {...props} name={name} target={relation.through.entity} value={value} onChange={change} error={error} />
      const field = model.entities[entity].fields[name]
      if (field?.type !== 'ref' || !field.entity) return undefined
      return <RelationPicker {...props} allowCreate={inline ? false : undefined} label={inline?.label} target={field.entity} field={name} value={value} selectedRow={selectedReferenceRow(model, entity, name, current)} onChange={change} error={error} />
    }} /></div>
  </>
}

/** Field-sized host for the same schema, PATCH, error and concurrency lifecycle. */
export function GeneratedInlineEdit(props: Context & InlineField & { row: Record<string, any>; children: ReactNode }) {
  const { t } = useEntityTranslation(props.entity)
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null); const editor = useRef<HTMLDivElement>(null)
  const allowed = inlineEditableField(props.model, props.entity, props.caps, props.field)
  const close = () => { setOpen(false); requestAnimationFrame(() => trigger.current?.focus()) }
  useEffect(() => {
    if (open) editor.current?.querySelector<HTMLElement>('input, textarea, select, button[role="combobox"], button[aria-haspopup]')?.focus()
  }, [open])
  useEffect(() => { if (!allowed) setOpen(false) }, [allowed])
  if (!allowed) return props.children
  return <div className="group space-y-2" data-inline-field={props.field}>
    <div className={open ? 'hidden' : 'flex items-start gap-2'}>{props.children}<Button ref={trigger} type="button" variant="ghost" size="icon" className="size-7 shrink-0 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 focus:opacity-100" aria-label={t('inlineEditField', { field: props.label })} onClick={() => setOpen(true)}><svg className="size-4" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m16 3 5 5-13 13H3v-5L16 3ZM14 5l5 5" /></svg></Button></div>
    {open && <div ref={editor} className="space-y-3" onKeyDown={event => {
      if (event.defaultPrevented || event.nativeEvent.isComposing) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); editor.current?.querySelector<HTMLButtonElement>('button[data-inline-cancel]')?.click() }
      if (event.key === 'Enter' && !event.shiftKey && event.target instanceof HTMLTextAreaElement) { event.preventDefault(); event.currentTarget.querySelector('form')?.requestSubmit() }
    }}><EntityMutation {...props} inline={props} controls={{ close, submissionKey: '' }} /></div>}
  </div>
}
function DeleteMutation({ row, close, ...props }: Context & { row: Record<string, any>; close: () => void }) {
  const { t } = useEntityTranslation(props.entity); const refresh = useRefresh(); const navigate = useNavigate(); const submit = useMutationSubmit()
  const mutation = useMutation({ mutationFn: () => props.write(`/api/${props.entity}/${encodeURIComponent(row.id)}`, 'DELETE'), onSuccess: async () => { close(); await navigate({ to: '/o/$orgId/e/$entity', params: { orgId: props.orgId, entity: props.entity } }); await refresh() } })
  return <form onSubmit={event => { event.preventDefault(); void submit(() => mutation.mutateAsync()) }}><WriteError error={mutation.error} /><MutationSubmitButton type="submit" variant="destructive" pending={mutation.isPending}>{t('delete')}</MutationSubmitButton></form>
}
function CommandMutation({ schema, name, values, controls, row, ...props }: Context & { row?: Record<string, any>; schema: Record<string, any>; name: string; values?: Record<string, any>; controls: { close: () => void; submissionKey: string } }) {
  const { t, i18n } = useEntityTranslation(props.entity)
  const command = props.model.commands?.find(command => command.name === name)
  const mutation = useCommandMutation(props, name, controls)
  const editing = row && command?.ui?.replacesCrud === 'update'
  const breadcrumbDenied = !visibleEntities(props.model, props.caps).includes(props.entity) || [403, 404].includes((mutation.error as WriteFailure | null)?.status ?? 0)
  usePublishRecordBreadcrumb(editing ? { orgId: props.orgId, entity: props.entity, id: String(row.id), status: breadcrumbDenied ? 'unavailable' : 'ready', label: breadcrumbDenied ? undefined : breadcrumbRecordLabel(props.model, props.entity, row, props.caps, i18n.language, t) } : undefined, 'edit')
  const label = (field: string) => t(`command_${field}`, { defaultValue: field })
  return <><WriteError error={mutation.error} command context={name.replace('/', '_')} /><RegistryForm optionLabel={value => t(`value_${value}`, { defaultValue: value })} schema={commandFormSchema(schema)} lockedValues={props.lockedValues} values={values} label={label} submitLabel={command ? commandLabel(command, i18n.language, t) : t('runCommand')} invalidLabel={t('invalidField')} pending={mutation.isPending} onSubmit={data => mutation.mutateAsync({ ...data, ...props.lockedValues })} relation={(field, value, change, error) => {
    // Command inputs carry their own references, including immutable entity fields.
    const target = schema.properties?.[field]?.referenceEntity
    if (typeof target !== 'string') return undefined
    return <RelationPicker {...props} allowCreate={false} target={target} field={field} label={label(field)} value={value} onChange={change} error={error} />
  }} /></>
}
/** Instance command forms share writes and refreshes. */
export function useCommandMutation(props: Pick<Context, 'write' | 'onDenied'>, name: string, controls: { close: () => void; submissionKey: string }) {
  const refresh = useRefresh()
  return useMutation({ mutationFn: (data: Record<string, any>) => props.write(`/commands/${name}`, 'POST', { ...data, idempotencyKey: controls.submissionKey }), onSuccess: async () => { await refresh(); controls.close() }, onError: (error: WriteFailure) => { if (commandError(error).denied) props.onDenied?.() } })
}
export function RelationPicker(props: Context & { allowCreate?: boolean; target: string; field: string; label?: string; value: string; selectedRow?: Record<string, any>; onChange: (value: string) => void; error?: string }) {
  const { t, i18n } = useEntityTranslation(props.entity); const { model, caps, orgId, target, field, value, onChange, request } = props
  const [wizard, setWizard] = useState(false)
  const choices = usePickerSearch(model, caps, orgId, target, request)
  const { allowed, search, rows, result } = choices
  const hydrated = useSelectedReferences(model, caps, orgId, target, [value], request)
  const hints = model.pickerHints?.[props.entity]?.[field]
  const name = (row: Record<string, any>) => {
    const display = caps.entities[target]?.displayField ?? model.entities[target].displayField
    if (display && !caps.entities[target]?.readable.includes(display)) return recordLabel(model, target, { id: row.id }, caps, i18n.language, t)
    if (hints?.labelTemplate) return hints.labelTemplate.replace(/\{(\w+)\}/g, (_, key) => caps.entities[target]?.readable.includes(key) ? row[key] == null ? '' : formatFieldValue(row[key], model.entities[target].fields[key], i18n.language, t, model.timeZone) : '').trim() || recordLabel(model, target, row, caps, i18n.language, t)
    return recordLabel(model, target, row, caps, i18n.language, t)
  }
  const refresh = useRefresh()
  const create = useMutation({ mutationFn: (data: Record<string, any>) => props.write(`/api/${target}`, 'POST', data, wizardKey), onSuccess: async row => { await refresh(); onChange(row.id); setWizard(false); choices.close() } })
  const [wizardKey, setWizardKey] = useState('')
  const schema = writeSchema(model, target, caps)
  const wizardAllowed = props.allowCreate !== false && hints?.wizard && caps.entities[target]?.operations.includes('create')
  const selected = hydrated.rows[0]
  const options = rows.map(row => ({ id: row.id, label: name(row) }))
  return <><WriteError error={result.error ?? hydrated.error} /><EntityPicker label={props.label ?? t(`field_${field}`)} placeholder={t('chooseRelation', { context: field })} remote options={options} value={value} selectedLabel={allowed && selected ? name(selected) : ''} onChange={id => { hydrated.seed(rows.find(row => row.id === id)); onChange(id) }}
    onFocus={choices.focus} onSearch={choices.setSearch} onClose={() => { choices.close(); setWizard(false) }} loading={choices.loading} hasMore={choices.hasMore} loadMore={choices.loadMore} loadingLabel={t('loading')} moreLabel={t('loadMore')} clearLabel={t('clearRelation')} emptyLabel={t('noResults')} error={props.error}
    wizard={wizardAllowed && (wizard ? <div><h3>{t('createRelated')}</h3><WriteError error={create.error} schema={schema} /><RegistryForm optionLabel={value => t(`value_${value}`, { defaultValue: value })} key={wizardKey} inline schema={schema} serverErrors={translatedFieldErrors(create.error, schema, t)} values={model.entities[target].displayField ? { [model.entities[target].displayField!]: search } : {}} label={name => formLabel(model, target, name, t)} submitLabel={t('createRelated')} invalidLabel={t('invalidField')} pending={create.isPending} onSubmit={data => create.mutateAsync(data)} /><Button type="button" variant="outline" disabled={create.isPending} onClick={() => setWizard(false)}>{t('cancelRelated')}</Button></div> : <Button type="button" variant="outline" onClick={() => { setWizardKey(crypto.randomUUID()); create.reset(); setWizard(true) }}>{t('createRelated')}</Button>)} />
  </>
}

/** Scope lifecycle notifications above the dialog's mutation session. */
function ResourceFormDialog({ entity, outcome, ...props }: ComponentProps<typeof SchemaFormDialog> & { entity: string; outcome?: string }) {
  const { t } = useEntityTranslation(entity); const labels = useMutationLabels()
  return <MutationLabelsProvider value={{ ...labels, saved: outcome ? t(outcome, { defaultValue: labels.saved }) : labels.saved }}><SchemaFormDialog {...props} /></MutationLabelsProvider>
}
function ResourceDeleteDialog({ entity, ...props }: ComponentProps<typeof DeleteActionDialog> & { entity: string }) {
  const { t } = useEntityTranslation(entity); const labels = useMutationLabels()
  return <MutationLabelsProvider value={{ ...labels, saved: t('deleted', { defaultValue: labels.saved }) }}><DeleteActionDialog {...props} /></MutationLabelsProvider>
}

export { commandError } from './write'

/** A context-bound create uses the same CRUD/command replacement choice as the root list. */
export function ContextCreateAction(props: Context & { lockedValues: Record<string, string> }) {
  const [open, setOpen] = useState(false)
  const { t, i18n } = useEntityTranslation(props.entity)
  const command = listCommandActions(props.model, props.entity, props.caps).create
  const fields = Object.keys(props.lockedValues)
  const allowed = command ? fields.every(field => command.inputSchema.properties?.[field]?.referenceEntity === props.model.entities[props.entity].fields[field]?.entity)
    : props.caps.entities[props.entity]?.operations.includes('create') && fields.every(field => writableFields(props.model, props.entity, props.caps).includes(field))
  if (!allowed) return null
  return <><Button onClick={() => setOpen(true)}>{resourceCreateLabel(props.model, props.entity, i18n.language, t, props.caps)}</Button><GeneratedCreateDialog {...props} open={open} onOpenChange={setOpen} /></>
}

type AccessContext = Omit<Context, 'write'> & { write?: WriteRequest; row: Record<string, any>; disabled?: boolean; email?: string; onChanged?: () => Promise<void> }
type AccessStatus = RowAccessStatus & { recordActions?: Record<string, { enabled: boolean }>; invitationUnavailable?: boolean }
/** The verified actor is part of every identity-bearing key, so a different actor never reads another's cached status. */
function accessQuery(props: Omit<AccessContext, 'row'> & { row?: Record<string, any> }, actor?: string) {
  return { queryKey: ['row-access', actor ?? null, props.orgId, props.entity, props.row?.id, props.caps], retry: false as const,
    queryFn: async (): Promise<AccessStatus> => {
      if (!hasRecordAccess(props.model, props.entity)) return props.write!(`/orgs/${encodeURIComponent(props.orgId)}/row-access/${encodeURIComponent(props.entity)}/${encodeURIComponent(props.row!.id)}`, 'GET')
      const row = await props.write!(`/api/${encodeURIComponent(props.entity)}/${encodeURIComponent(props.row!.id)}`, 'GET')
      const access = row.access
      return { ...access, state: access?.state === 'linked' ? 'signed_in' : access?.state,
        linked_accounts: access?.linked_accounts ?? (access?.account ? [{ id: access.account.id, label: access.account.display_name ?? access.account.email }] : []),
        inconsistency: access?.inconsistency ?? null, can_invite: row.actions?.invite?.enabled === true,
        can_cancel: row.actions?.cancel_invite?.enabled === true, invitationUnavailable: row.access === undefined, recordActions: row.actions ?? {} }
    } }
}
function accessGuard(data?: AccessStatus) {
  const multiple = !!data && (data.inconsistency === 'multiple_linked_accounts' || (data.linked_accounts?.length ?? 0) > 1)
  return { multiple, valid: !!data && !multiple && ['no_account', 'invited', 'expired', 'signed_in'].includes(data.state) && data.inconsistency == null }
}
export function canReadApplicationAccess(caps: Capabilities) { return caps.resources?.['invitations.read'] === true }
function useApplicationAccess(props: Omit<AccessContext, 'row'> & { row?: Record<string, any> }) {
  const actor = useReferenceAuthority()?.actor
  const pending = useIsMutating({ mutationKey: ['account-access', props.orgId, props.entity] }) > 0
  const definition = props.model.entities[props.entity]
  const supported = hasRecordAccess(props.model, props.entity) || !!(definition?.rowAccess ?? definition?.rowInvitations)
  const enabled = canReadApplicationAccess(props.caps) && !!props.write && !!props.row && supported
  const status = useQuery({ ...accessQuery(props, actor), enabled })
  const data = enabled && !status.error ? status.data : undefined
  const { multiple, valid } = accessGuard(data)
  const granted = (name: string) => props.caps.commands?.includes(`${props.entity}/${name}`)
  const v3 = hasRecordAccess(props.model, props.entity)
  // A structurally unavailable Members status does not remove separately granted
  // legacy link/unlink controls. An attempted but uncertain status always blocks.
  // Without invitation-read authority, V3 still returns independently
  // authorized live link/unlink availability. Omitted access is distinct from
  // an unknown state, failed read or an inconsistent response.
  const explicitOnly = !!data && v3 && definition.rowAccess === false && data.invitationUnavailable === true && data.inconsistency == null && !multiple
  const explicit = !!props.write && !!props.row && (!supported || valid || explicitOnly)
  const inviteGranted = v3 ? granted('access_invite') : data?.can_invite
  const cancelGranted = v3 ? granted('access_cancel_invite') : data?.can_cancel
  const actions = !valid ? [] : data!.state === 'no_account' && data!.can_invite && inviteGranted ? ['invite'] : ['invited', 'expired'].includes(data!.state) && data!.invitation
    ? [...(inviteGranted ? ['resend', ...(data!.state === 'invited' ? ['copy'] : [])] : []), ...(data!.can_cancel && cancelGranted ? ['cancel', ...(inviteGranted ? ['change'] : [])] : [])]
    : []
  if (valid && data!.state === 'expired' && inviteGranted && data!.can_invite && !actions.includes('change')) actions.push('change')
  // Older servers omit the search capability. Preserve their authorized picker;
  // an explicit denial still blocks both the picker and the new search flow.
  if (data?.state !== 'signed_in' && explicit && props.caps.resources?.['members.read'] === true && props.caps.resources?.['members.search_link_account'] !== false && (v3 ? granted('access_link_account') && data?.recordActions?.link_account?.enabled : granted('link_account'))) actions.push('link')
  if (explicit && (v3 ? granted('access_unlink_account') && data?.recordActions?.unlink_account?.enabled : granted('remove_access'))) actions.push('remove')
  return { enabled, supported, status, multiple, valid, explicitOnly, actions, blocked: pending || !!props.disabled || !props.write || !props.row || supported && ((!valid && !explicitOnly) || status.isFetching || !!status.error) }
}

/** All account action entry points use this controller, including nested edit dialogs. */
export function GeneratedRowInvitation(props: Context & { row: Record<string, any>; disabled?: boolean }) {
  return !canReadApplicationAccess(props.caps) || !(props.model.entities[props.entity]?.accountLink || props.model.entities[props.entity]?.rowInvitations) ? null : <ApplicationAccess {...props} rowMenu />
}
export function ApplicationAccessCard(props: AccessContext) {
  const { t } = useTranslation()
  if (!canReadApplicationAccess(props.caps)) return null
  return <Card data-application-access=""><CardHeader><CardTitle>{t('rowAccess')}</CardTitle></CardHeader><CardContent><ApplicationAccess {...props} /></CardContent></Card>
}
function ApplicationAccess(props: AccessContext & { rowMenu?: boolean }) {
  const authority = useReferenceAuthority()
  // Standalone access controls must also suspend while the host establishes identity.
  return authority && authority.actor === undefined ? null : <ApplicationAccessBody {...props} />
}
function ApplicationAccessBody(props: AccessContext & { rowMenu?: boolean }) {
  const actor = useReferenceAuthority()?.actor
  const [selected, setSelected] = useState<string>()
  const [menuOpen, setMenuOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const requested = useRef<string | undefined>(undefined)
  const { enabled, status, multiple, valid, explicitOnly, actions, blocked } = useApplicationAccess(props)
  const { t } = useTranslation()
  const data = status.data
  useEffect(() => {
    if (!menuOpen) return
    // Consume Escape before the underlying edit dialog's document listener.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation(); setMenuOpen(false)
    }
    window.addEventListener('keydown', escape, true)
    return () => window.removeEventListener('keydown', escape, true)
  }, [menuOpen])
  const delivery = useQuery({ queryKey: ['row-access-delivery', actor ?? null, props.orgId, props.entity, props.row.id, data?.invitation?.id, props.caps], retry: false,
    enabled: !blocked && data?.state === 'invited' && !!data.invitation && actions.includes('resend'),
    queryFn: async () => {
      const result = await props.write!(`/orgs/${encodeURIComponent(props.orgId)}/invitations/${encodeURIComponent(data!.invitation!.id)}/delivery`, 'GET')
      return result.delivery?.status === 'failed'
    } })
  const message = !enabled ? 'rowAccessUnavailable' : status.error ? ((status.error as WriteFailure).status === 403 ? 'rowAccessDenied' : (status.error as WriteFailure).status === 404 ? 'rowAccessUnavailable' : 'requestFailed') : !data ? 'loading' : explicitOnly ? 'rowAccessUnavailable' : multiple ? 'rowAccessMultiple' : !valid ? 'requestFailed' : undefined
  // Keep mounted dialogs/drafts during a cached refetch; every trigger and submit
  // is disabled by the same guard until the response settles.
  const find = data?.state !== 'signed_in' && (actions.includes('change') || actions.includes('invite') || actions.includes('link') && props.caps.resources?.['members.search_link_account'] === true)
  const selectionAllowed = selected === 'find' ? find : !!selected && actions.includes(selected)
  useEffect(() => {
    if (selected && !selectionAllowed) setSelected(undefined)
  }, [selected, selectionAllowed])
  const visibleActions = [...actions.filter(action => !(find && ['link', 'invite', 'change'].includes(action))), ...(find ? ['find'] : [])]
  const pendingMenu = props.rowMenu && valid && data?.state === 'invited'
  // Pending invitations have a specific order; every entry still comes from
  // the live controller, including the unified find-or-invite dialog.
  const pendingOrder = ['resend', 'copy', 'find']
  const pendingActions = [...pendingOrder.filter(action => visibleActions.includes(action)),
    ...visibleActions.filter(action => !pendingOrder.includes(action) && action !== 'cancel'),
    ...visibleActions.filter(action => action === 'cancel')]
  const overflow = props.rowMenu ? pendingMenu ? pendingActions : visibleActions : visibleActions.filter(action => action === 'cancel')
  const label = (action: string) => t(action === 'find' ? pendingMenu ? 'rowChangeMemberOrEmail' : 'rowFindMember' : `rowInvite_${action}`)
  const open = (action: string, button: HTMLButtonElement) => { trigger.current = button; setSelected(action) }
  const stateLabel = t(message ?? `rowAccess_${data?.state}`)
  // A policy-hidden identity never falls back to a raw account field.
  const identity = data?.linked_accounts?.[0]?.label ?? data?.linked_accounts?.[0]?.id ?? data?.invitation?.email
  const triggerText = data?.state === 'no_account' ? '–' : identity ?? '–'
  const rowControl = props.rowMenu && (!message || !!overflow.length)
  const dotClass = data?.state === 'signed_in' ? 'bg-green-600' : data?.state === 'invited' ? 'bg-amber-500' : data?.state === 'expired' ? 'bg-red-600' : 'bg-slate-400'
  return <div className="flex flex-wrap items-center gap-2" aria-label={t('rowAccess')}>
    {message ? !rowControl && <span role={status.error || data ? 'alert' : 'status'}>{t(message)}</span> : !props.rowMenu && <>
      <Badge role="status" variant="secondary" className={data!.state === 'expired' ? 'bg-red-100 text-red-800' : data!.state === 'invited' ? 'bg-amber-100 text-amber-800' : data!.state === 'signed_in' ? 'bg-green-100 text-green-800' : undefined}>{t(`rowAccess_${data!.state}`)}</Badge>
      {data!.linked_accounts?.[0] && <span className="min-w-0 max-w-full whitespace-normal text-sm [overflow-wrap:anywhere]">{data!.linked_accounts[0].label ?? data!.linked_accounts[0].id}</span>}
      {data!.invitation && <span className="min-w-0 max-w-full whitespace-normal text-sm [overflow-wrap:anywhere]">{data!.invitation.email}</span>}
    </>}
    {enabled && !status.isFetching && (status.error || data && !valid && !multiple && !explicitOnly) && <Button type="button" variant="outline" onClick={() => { void status.refetch() }}>{t('reloadRetry')}</Button>}
    {delivery.data === true && <span role="alert">{t('rowInviteDeliveryFailed')}</span>}
    {status.isFetching && data && !multiple && <span role="status">{t('rowAccessRefreshing')}</span>}
    {(!props.rowMenu ? visibleActions.filter(action => !overflow.includes(action)) : []).map(action =>
      <Button key={action} type="button" variant="outline" disabled={blocked} onClick={event => open(action, event.currentTarget)}>{label(action)}</Button>)}
    {(props.rowMenu ? rowControl : !!overflow.length) && <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      {props.rowMenu ? <TooltipProvider><Tooltip><TooltipTrigger asChild><DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="relative h-6 max-w-full gap-1 px-1 py-0 has-[>svg]:px-1 pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2.5 pointer-coarse:after:inset-x-0 pointer-coarse:after:min-w-11" disabled={blocked}
          aria-label={`${triggerText} – ${stateLabel}, ${t('rowAccessActions')}`} onFocus={event => { trigger.current = event.currentTarget }} onClick={event => { trigger.current = event.currentTarget }}>
          <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${dotClass}`} />
          <span className="min-w-0 whitespace-normal text-left [overflow-wrap:anywhere]">{triggerText}</span>
          <svg aria-hidden="true" className="size-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
        </Button>
      </DropdownMenuTrigger></TooltipTrigger><TooltipContent>{stateLabel}</TooltipContent></Tooltip></TooltipProvider>
        : <DropdownMenuTrigger asChild><Button type="button" variant="outline" size="sm" className="pointer-coarse:min-h-11 pointer-coarse:min-w-11" disabled={blocked} aria-label={t('rowInvitationActions')} onFocus={event => { trigger.current = event.currentTarget }} onClick={event => { trigger.current = event.currentTarget }}>⋯</Button></DropdownMenuTrigger>}
      <DropdownMenuContent align="end" onCloseAutoFocus={event => { if (requested.current) { event.preventDefault(); setSelected(requested.current); requested.current = undefined } }}>
        {props.rowMenu && <><DropdownMenuLabel className="flex items-center gap-2"><span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${dotClass}`} />{stateLabel}</DropdownMenuLabel><DropdownMenuSeparator /></>}
        {overflow.map((action, index) => <div key={action}>{pendingMenu && action === 'cancel' && index > 0 && <DropdownMenuSeparator />}<DropdownMenuItem variant={action === 'cancel' ? 'destructive' : 'default'} className="pointer-coarse:min-h-11" onSelect={() => { requested.current = action }}>{label(action)}</DropdownMenuItem></div>)}
      </DropdownMenuContent>
    </DropdownMenu>}
    {selected && <ResourceFormDialog entity={props.entity} key={selected} open onOpenChange={open => { if (!open) setSelected(undefined) }}
      onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus() }} schema={actionSchema(selected)}
      title={label(selected)} description={t(selected === 'find' ? 'rowFindDescription' : selected === 'link' ? 'rowLinkDescription' : selected === 'remove' || selected === 'change' && data?.state === 'signed_in' ? 'rowInviteRemoveDescription' : 'rowInviteDescription')} cancelLabel={t('cancel')}>
      {controls => selected === 'find' ? <FindMemberOrInvite {...props} email={data?.invitation?.email ?? props.email} write={props.write!} controls={controls} /> : <RowInvitationMutation {...props} write={props.write!} action={selected} controls={controls} />}
    </ResourceFormDialog>}
  </div>
}
const emptyRowSchema = { type: 'object' as const, properties: {}, additionalProperties: false }
const rowInviteSchema = { type: 'object' as const, properties: { email: { type: 'string' as const, format: 'email' } }, required: ['email'], additionalProperties: false }
const rowInviteValidator = formValidator(rowInviteSchema)
const rowLinkSchema = { type: 'object' as const, properties: { user_id: { type: 'string' as const } }, required: ['user_id'], additionalProperties: false }
const actionSchema = (action: string) => action === 'invite' || action === 'change' ? rowInviteSchema : action === 'link' ? rowLinkSchema : emptyRowSchema
async function inviteRecord(props: AccessContext & { write: WriteRequest }, email: string) {
  const result = hasRecordAccess(props.model, props.entity)
    ? await props.write(`/api/${encodeURIComponent(props.entity)}/${encodeURIComponent(props.row.id)}/actions/invite`, 'POST', { email })
    : await props.write(`/orgs/${encodeURIComponent(props.orgId)}/invitations`, 'POST', { email, target: { entity: props.entity, row: props.row.id } })
  if (result?.delivery?.status === 'failed') throw { code: 'invitation_delivery_failed' }
  // Discard accept_url and any other credential-bearing result immediately.
}
type InvitationMutationProps = Context & AccessContext & { action: string; controls: { close: () => void; submissionKey: string }; onLinkConflict?: (id: string) => Promise<void> }
function useInvitationMutation(props: InvitationMutationProps, access: ReturnType<typeof useApplicationAccess>) {
  const refresh = useRefresh(); const client = useQueryClient(); const actor = useReferenceAuthority()?.actor
  const mutation = useMutation({ mutationKey: ['account-access', props.orgId, props.entity], gcTime: 0, retry: false, mutationFn: async (values: Record<string, any>) => {
    const base = `/orgs/${encodeURIComponent(props.orgId)}/invitations`
    const record = `/api/${encodeURIComponent(props.entity)}/${encodeURIComponent(props.row.id)}/actions`
    const v3 = hasRecordAccess(props.model, props.entity)
    const cancel = async () => { if (v3) await props.write(`${record}/cancel_invite`, 'POST', {}); else await props.write(`${base}/${encodeURIComponent(access.status.data!.invitation!.id)}`, 'DELETE') }
    const remove = async () => { if (v3) await props.write(`${record}/unlink_account`, 'POST', {}); else await props.write(`/commands/${props.entity}/remove_access`, 'POST', { rowId: props.row.id, idempotencyKey: props.controls.submissionKey }) }
    let failure: unknown
    try {
      if (props.action === 'invite') await inviteRecord(props, values.email)
      else if (props.action === 'link') {
        if (v3) await props.write(`${record}/link_account`, 'POST', { user_id: values.user_id })
        else await props.write(`/commands/${props.entity}/link_account`, 'POST', { rowId: props.row.id, userId: values.user_id, idempotencyKey: props.controls.submissionKey })
      } else if (props.action === 'change') {
        if (!['invited', 'expired'].includes(access.status.data?.state ?? '')) throw { code: 'action_unavailable' }
        if (access.status.data?.state !== 'expired') await cancel()
        const data = await client.fetchQuery({ ...accessQuery(props, actor), staleTime: 0 })
        if (!accessGuard(data).valid || !data.can_invite) throw { code: 'action_unavailable' }
        await inviteRecord(props, values.email)
      } else if (props.action === 'copy') {
        const result = await props.write(`${base}/${encodeURIComponent(access.status.data!.invitation!.id)}/copy-link`, 'POST', {})
        await navigator.clipboard.writeText(result.accept_url)
      } else if (props.action === 'resend') await props.write(`${base}/${encodeURIComponent(access.status.data!.invitation!.id)}/resend`, 'POST', {})
      else if (props.action === 'cancel') await cancel()
      else await remove()
    } catch (error) {
      failure = error
      const conflict = error as WriteFailure
      if (props.action === 'link' && conflict.status === 409 && conflict.code === 'account_already_linked') {
        await props.onLinkConflict?.(values.user_id)
      }
    } finally {
      // Reconcile even an uncertain/partially successful response before retry,
      // retaining the original denial if a reconciliation read also fails.
      try { await refresh(); await props.onChanged?.() } catch (error) { failure ??= error }
    }
    if (failure) throw failure
    // Credentials are never returned to the mutation cache.
  }, onSuccess: () => props.controls.close(), onError: (error: WriteFailure) => { if (error.status === 403) props.onDenied?.() } })
  return mutation
}
function RowInvitationMutation(props: InvitationMutationProps) {
  const { t } = useTranslation(); const access = useApplicationAccess(props); const actor = useReferenceAuthority()?.actor
  const [generation, setGeneration] = useState(0)
  const [rejected, setRejected] = useState<string>()
  const canLink = props.action === 'link' && access.actions.includes('link')
  const members = useQuery({ queryKey: ['account-link-members', actor ?? null, props.orgId, props.entity, props.row.id, props.caps], retry: false,
    enabled: canLink && !access.blocked,
    queryFn: async (): Promise<{ data: LinkMember[] }> => props.write(`/orgs/${encodeURIComponent(props.orgId)}/members?eligible=link_account&target_entity=${encodeURIComponent(props.entity)}&target_row=${encodeURIComponent(props.row.id)}`, 'GET'),
  })
  const choices = canLink && !members.error && !members.isFetching ? (members.data?.data ?? []).filter(member => member.user_id !== rejected) : []
  const schema = props.action === 'link' ? { ...rowLinkSchema, properties: { user_id: { type: 'string' as const, enum: choices.map(member => member.user_id) } } } : actionSchema(props.action)
  const mutation = useInvitationMutation({ ...props, onLinkConflict: async id => { setRejected(id); setGeneration(value => value + 1) } }, access)
  return <><WriteError schema={schema} error={mutation.error ?? (props.action === 'link' ? members.error : null)} />
    {props.action === 'link' && <p className="text-sm text-muted-foreground">{t('rowLinkPickerHint')}</p>}
    {props.action === 'link' && members.isFetching && <span role="status">{t('loading')}</span>}
    {props.action === 'link' && !members.isPending && !members.isFetching && !members.error && !choices.length && <span role="status">{t('rowInviteNoMembers')}</span>}
    <RegistryForm key={generation} schema={schema} serverErrors={translatedFieldErrors(mutation.error, schema, t)} values={{ email: props.email ?? '' }}
      optionLabel={id => { const member = choices.find(member => member.user_id === id); return member ? memberLabel(member) : id }}
      label={name => t(name === 'user_id' ? 'rowInviteAccount' : 'email')} submitLabel={t(`rowInvite_${props.action}`)} invalidLabel={t('invalidField')} pending={mutation.isPending} disabled={access.blocked || props.action === 'link' && (members.isFetching || !!members.error || !choices.length)}
      onSubmit={values => {
        if (access.blocked || !access.actions.includes(props.action) || props.action === 'link' && !choices.some(member => member.user_id === values.user_id)) return Promise.reject({ code: 'action_unavailable' })
        return mutation.mutateAsync(values)
      }} /></>
}
type LinkMember = { user_id: string; display_name?: string | null; email?: string; linkable?: boolean; link_reason?: 'account_already_linked' | 'account_not_linkable' }
const memberLabel = (member: LinkMember) => [member.display_name, member.email !== member.display_name ? member.email : undefined].filter(Boolean).join(' · ') || member.user_id
function FindMemberOrInvite(props: Omit<InvitationMutationProps, 'action'>) {
  const { t } = useTranslation(); const access = useApplicationAccess(props); const actor = useReferenceAuthority()?.actor
  const [search, setSearch] = useState(props.email ?? ''); const [query, setQuery] = useState('')
  const [selectedMember, setSelected] = useState<LinkMember>()
  const [rejected, setRejected] = useState<string>()
  const canSearch = access.actions.includes('link')
  const selected = canSearch ? selectedMember : undefined
  useEffect(() => { const timer = setTimeout(() => setQuery(search.trim()), 300); return () => clearTimeout(timer) }, [search])
  const members = useQuery({ queryKey: ['account-link-members', actor ?? null, props.orgId, props.entity, props.row.id, props.caps, query], retry: false,
    enabled: canSearch && !access.blocked && !!query && search.trim() === query,
    queryFn: async (): Promise<{ data: LinkMember[] }> => props.write(`/orgs/${encodeURIComponent(props.orgId)}/members?eligible=link_account&target_entity=${encodeURIComponent(props.entity)}&target_row=${encodeURIComponent(props.row.id)}&q=${encodeURIComponent(query)}`, 'GET'),
  })
  const loading = search.trim() !== query || members.isFetching
  // Recheck authority before using cached data, including after a role change.
  const choices = canSearch && !loading && !members.error ? (members.data?.data ?? []).map(member => member.user_id === rejected ? { ...member, linkable: false, link_reason: 'account_already_linked' as const } : member) : []
  const unavailable = selected?.linkable === false ? selected : choices.find(member => member.linkable === false && member.email?.toLocaleLowerCase() === query.toLocaleLowerCase())
  const mutation = useInvitationMutation({ ...props, action: selected ? 'link' : access.actions.includes('change') ? 'change' : 'invite', onLinkConflict: async id => { setRejected(id); setSelected(undefined); await members.refetch() } }, access)
  const conflict = (mutation.error as WriteFailure | null)?.code === 'account_already_linked'
  const invite = (access.actions.includes('invite') || access.actions.includes('change')) && !selected && !!query && !loading && (!canSearch || members.isSuccess) && !members.error && !choices.length && !conflict && rowInviteValidator.safeParse({ email: search.trim() }).success
  const reason = unavailable ? t(unavailable.link_reason === 'account_already_linked' ? 'write_account_already_linked' : 'rowAccountNotLinkable') : conflict ? t('write_account_already_linked') : !selected && !invite ? t('rowFindRequired') : t('rowLinkPickerHint')
  const disabled = access.blocked || loading || !!members.error || selected?.linkable === false || !selected && !invite
  return <div className="grid gap-3 [&_button]:min-h-11 [&_button]:min-w-11 [&_input]:min-h-11 [&_input]:pr-20 [&_[role=option]]:min-h-11">
    <EntityPicker remote label={t('rowFindQuery')} placeholder={t('rowFindQuery')} value={selected?.user_id ?? ''} selectedLabel={selected ? memberLabel(selected) : search} search={search}
      description={conflict ? undefined : reason} options={choices.map(member => ({ id: member.user_id, label: memberLabel(member) + (member.linkable === false ? ` — ${t(member.link_reason === 'account_already_linked' ? 'write_account_already_linked' : 'rowAccountNotLinkable')}` : '') }))} loading={canSearch && loading} loadingLabel={t('loading')} emptyLabel={query && !members.error ? t('rowInviteNoMembers') : undefined} clearLabel={t('rowFindClear')}
      error={conflict ? t('write_account_already_linked') : undefined}
      onSearch={value => { setSearch(value); setSelected(undefined); mutation.reset() }}
      onChange={id => { setSelected(choices.find(member => member.user_id === id)); mutation.reset() }} />
    <WriteError error={!conflict ? mutation.error ?? (canSearch ? members.error : null) : null} />
    {selected && selected.linkable !== false && canSearch && <div aria-live="polite"><p className="break-all">{memberLabel(selected)}</p><p>{t('rowLinkDescription')}</p>{access.status.data?.state === 'invited' && access.status.data.invitation && <p>{t('rowLinkSupersedes', { email: access.status.data.invitation.email })}</p>}</div>}
    {invite && <p>{t('rowInviteDescription')}</p>}
    <RegistryForm schema={emptyRowSchema} label={name => name} submitLabel={t(selected ? 'rowInvite_link' : access.actions.includes('change') ? 'rowInvite_change' : 'rowFindSend')} invalidLabel={t('invalidField')} pending={mutation.isPending} disabled={disabled}
      onSubmit={() => {
        if (disabled || (selected ? !choices.some(member => member.user_id === selected.user_id) : !invite)) return Promise.reject({ code: 'action_unavailable' })
        return mutation.mutateAsync(selected ? { user_id: selected.user_id } : { email: search.trim() })
      }} />
  </div>
}
