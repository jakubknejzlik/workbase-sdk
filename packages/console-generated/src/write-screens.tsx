import { editableManyRelations, memberships, syncMemberships } from './many-to-many'
import { ManyRelationField } from './many-relation-field'
import type { ComponentProps, ReactNode } from 'react'
import { createDataTableQueryKey } from '@workbasehq/ui'
import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { useEntityTranslation } from './entity-translation'
import { SchemaFormDialog, DeleteActionDialog, Button, EntityPicker, RegistryForm, MutationLabelsProvider, useMutationLabels, MutationSubmitButton, MutationErrorAlert, RowActions, useMutationSubmit, type RegistrySchema } from '@workbasehq/ui'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@workbasehq/ui/components/ui/dropdown-menu'
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
  // Closed write codes describe a refused mutation, even with HTTP 403.
  return failure.status === 404 ? 'notFoundDescription' : codes.includes(failure.code ?? '') ? `write_${failure.code}` : failure.status === 403 ? 'forbiddenDescription' : 'requestFailed'
}
function writeFieldErrors(error: unknown, schema?: RegistrySchema): Record<string, string> {
  const failure = error as WriteFailure | null; const key = writeErrorKey(error)
  if (!schema || !failure || !codes.includes(failure.code ?? '') || !key) return {}
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
export function resourceCreateLabel(model: Model, entity: string, language: string, t: (key: string, options?: any) => string, caps?: Capabilities) {
  const command = caps && listCommandActions(model, entity, caps).create
  if (command) return commandLabel(command, language, t)
  return t('addEntity', { context: entity, entity: t(`entityObject_${entity}`, { defaultValue: t(`entitySingular_${entity}`, { defaultValue: t(`entity_${entity}`, { defaultValue: entity.replaceAll('_', ' ') }) }) }) })
}
export function GeneratedCreateDialog(props: Context & { open: boolean; onOpenChange: (open: boolean) => void; onCloseAutoFocus?: (event: Event) => void }) {
  const { t } = useEntityTranslation(props.entity)
  if (!visibleEntities(props.model, props.caps).includes(props.entity)) return null
  const command = listCommandActions(props.model, props.entity, props.caps).create
  if (command) return <CreateCommandDialog {...props} command={command} />
  if (!props.caps.entities[props.entity].operations.includes('create')) return null
  return <ResourceFormDialog entity={props.entity} outcome="created" schema={writeSchema(props.model, props.entity, props.caps)} open={props.open} onOpenChange={props.onOpenChange} onCloseAutoFocus={props.onCloseAutoFocus} title={t('createEntity', { entity: t(`entitySingular_${props.entity}`) })} description={t('createEntityDescription', { entity: t(`entitySingular_${props.entity}`) })} cancelLabel={t('cancel')}>{controls => <EntityMutation {...props} controls={controls} />}</ResourceFormDialog>
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
    {row && <GeneratedRowInvitation {...props} row={row} />}
    {createCommand && <CreateCommandDialog {...props} command={createCommand} />}
    {(!row ? ['create'] : ['update']).filter(operation => operations.includes(operation) && (operation !== 'update' || caps.entities[entity].readable.includes('version'))).map(operation => <ResourceFormDialog entity={entity} outcome={row ? 'updated' : 'created'} schema={writeSchema(model, entity, caps, row ? 'edit' : 'create')} compact={!!row} key={operation} trigger={operation === 'create' ? createLabel : t('edit', { context: '' })} triggerIcon={row ? 'edit' : undefined} triggerVariant={row ? 'secondary' : undefined} title={t(operation === 'create' ? 'createEntity' : 'editEntity', { entity: t(`entitySingular_${entity}`) })} description={t(operation === 'create' ? 'createEntityDescription' : 'editEntityDescription', { entity: t(`entitySingular_${entity}`) })} cancelLabel={t('cancel')}>{controls => <EntityMutation {...props} row={row} controls={controls} />}</ResourceFormDialog>)}
    {row && operations.includes('delete') && <ResourceDeleteDialog entity={entity} entityType={t(`entity_${entity}`, { defaultValue: entity })} entityName={recordLabel(model, entity, row, caps, i18n.language, t)} targetDescription={t('deleteTarget')} warningMessage={t('deleteDescription')} confirmText={t('delete')} compact trigger={t('delete', { context: '' })} triggerIcon="delete" triggerVariant="destructive" title={t('deleteRecord')} description={t('deleteDescription')} cancelLabel={t('cancel')} destructive>{controls => <DeleteMutation {...props} row={row} close={controls.close} />}</ResourceDeleteDialog>}
    {row ? commandDefinitions(model, entity, caps).filter(command => !!commandRowField(command, entity) && !(model.entities[entity].rowInvitations && command.name === `${entity}/remove_access`)).map(command => {
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
  const commands = commandDefinitions(model, entity, caps).filter(command => !!commandRowField(command, entity) && !(model.entities[entity].rowInvitations && command.name === `${entity}/remove_access`))
  const items = [
    ...(operations.includes('update') && caps.entities[entity].readable.includes('version') ? [{ id: 'edit', label: t('edit') }] : []),
    ...commands.map(command => ({ id: command.name, label: commandLabel(command, i18n.language, t) })),
    ...(operations.includes('delete') ? [{ id: 'delete', label: t('delete'), destructive: true }] : []),
  ]
  return <><GeneratedRowInvitation {...props} /><RowActions label={t('rowActions', { name: recordLabel(model, entity, row, caps, i18n.language, t) })} items={items} disabled={props.disabled}>{(action, close, restoreFocus) => {
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
  return () => Promise.all([client.invalidateQueries({ queryKey: createDataTableQueryKey() }), client.invalidateQueries({ queryKey: ['read'] }), client.invalidateQueries({ queryKey: ['picker'] }), client.invalidateQueries({ queryKey: ['lookup'] }), client.invalidateQueries({ queryKey: ['row-access'] })])
}
function formLabel(model: Model, entity: string, name: string, translate: (key: string, options?: any) => string) {
  const section = model.entities[entity].sections?.find(section => `section:${section.id}` === name)
  return section ? translate(section.label, { defaultValue: section.label }) : translate(`field_${name}`)
}
interface InlineField { field: string; label: string; value: ReactNode; refresh: () => Promise<Result> }
function EntityMutation(props: Context & { row?: Record<string, any>; controls: { close: () => void; submissionKey: string }; inline?: InlineField }) {
  const { t, i18n } = useEntityTranslation(props.entity); const { model, caps, entity, row, controls, write, request, inline } = props; const refreshAll = useRefresh()
  const refresh = inline?.refresh ?? refreshAll
  const [current, setCurrent] = useState(row); const [generation, setGeneration] = useState(0)
  const needsEditRead = !inline && !!row && !!model.entities[entity].detail?.groups
  const editRecord = useQuery({ queryKey: ['read', model.instance, props.orgId, caps, entity, row?.id, 'edit-record'], enabled: needsEditRead, queryFn: () => request(readQuery(model, entity, caps, { id: row!.id, purpose: 'edit' })) })
  const editingRow = current !== row ? current : needsEditRead ? editRecord.data?.data[0] : current
  const orgId = props.orgId
  const fullSchema = writeSchema(model, entity, caps, row ? 'edit' : 'create')
  const schema = inline ? { ...fullSchema, properties: { [inline.field]: { ...fullSchema.properties[inline.field], 'x-ui': { ...fullSchema.properties[inline.field]['x-ui'], span: 'full', section: undefined } } }, required: fullSchema.required.filter((name: string) => name === inline.field) } : fullSchema
  const relations = editableManyRelations(model, entity, caps).filter(([name]) => Object.hasOwn(schema.properties, name))
  const initial = useQuery({ queryKey: ['read', model.instance, orgId, caps, entity, row?.id, 'form-memberships', generation], enabled: !!row && !!relations.length, queryFn: async () => Object.fromEntries(await Promise.all(relations.map(async ([name, relation]) => [name, row ? [...new Set((await memberships(model, relation, row.id, request)).map(item => item[relation.through!.field]))] : []]))) })
  const saved = useRef<{ row?: Record<string, any>; fields?: string }>({ row })
  const mutation = useMutation({ mutationFn: async (data: Record<string, any>) => {
    const fields = Object.fromEntries(Object.entries({ ...data, ...props.lockedValues }).filter(([name]) => !relations.some(([key]) => key === name)))
    const fingerprint = JSON.stringify(fields)
    if (!saved.current.row || Object.keys(fields).length && saved.current.fields !== fingerprint) {
      const parent = saved.current.fields ? saved.current.row : editingRow ?? saved.current.row
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
  }, onSuccess: async () => { await refresh(); controls.close() }, onError: async (error: WriteFailure) => {
    if (error.status === 403 && !codes.includes(error.code ?? '')) props.onDenied?.()
    // Keep the refused draft frozen, but immediately show the current detail value.
    if (inline && error.code === 'version_conflict') await inline.refresh().catch(() => {})
  } })
  const reload = useMutation({ mutationFn: () => inline ? inline.refresh() : request(readQuery(model, entity, caps, { id: current!.id, purpose: 'edit' })), onSuccess: result => { if (!result.data[0]) return; setCurrent(result.data[0]); saved.current = { row: result.data[0] }; setGeneration(value => value + 1); mutation.reset() } })
  const breadcrumbDenied = !visibleEntities(model, caps).includes(entity) || [403, 404].includes((mutation.error as WriteFailure | null)?.status ?? 0) || !!reload.error
  usePublishRecordBreadcrumb(!inline && row && current ? { orgId, entity, id: String(current.id), status: breadcrumbDenied ? 'unavailable' : 'ready', label: breadcrumbDenied ? undefined : breadcrumbRecordLabel(model, entity, current, caps, i18n.language, t) } : undefined, 'edit')
  const conflict = (mutation.error as { code?: string } | null)?.code === 'version_conflict'
  const values = Object.fromEntries(writableFields(model, entity, caps).filter(field => editingRow?.[field] !== undefined).map(field => [field, editingRow![field]]))
  if (needsEditRead && editRecord.isPending || row && relations.length && initial.isPending) return <p role="status">{t('loading')}</p>
  if (needsEditRead && (editRecord.error || !editingRow)) return <><WriteError error={editRecord.error ?? { code: 'entity_not_found' }} /><Button onClick={() => { void editRecord.refetch() }}>{t('reloadRetry')}</Button></>
  if (initial.error) return <><WriteError error={initial.error} /><Button onClick={() => { void initial.refetch() }}>{t('reloadRetry')}</Button></>
  return <><WriteError error={mutation.error ?? reload.error} schema={schema} />
    {conflict && inline && <p role="status">{t('inlineFreshValue')}: {inline.value}</p>}
    {conflict && <Button type="button" disabled={reload.isPending} onClick={() => reload.mutate()}>{t('reloadRetry')}</Button>}
    <RegistryForm secondaryAction={inline && <Button data-inline-cancel type="button" variant="outline" disabled={mutation.isPending || reload.isPending} onClick={controls.close}>{t('cancel')}</Button>} optionLabel={value => t(`value_${value}`, { defaultValue: value })} key={generation} requireDirty={!!current} partial={!!current} schema={schema} lockedValues={props.lockedValues} values={{ ...props.initialValues, ...values, ...initial.data }} label={name => inline?.label ?? formLabel(model, entity, name, t)} submitLabel={inline ? t('save', { context: '' }) : t(current ? 'save' : 'create')} invalidLabel={t('invalidField')} pending={mutation.isPending || reload.isPending} disabled={conflict} serverErrors={translatedFieldErrors(mutation.error, schema, t)} onSubmit={data => mutation.mutateAsync(data)} relation={(name, value, change, error) => {
      const relation = relations.find(([key]) => key === name)?.[1]
      if (relation?.through) return <ManyRelationField {...props} name={name} target={relation.through.entity} value={value} onChange={change} error={error} />
      const field = model.entities[entity].fields[name]
      if (field?.type !== 'ref' || !field.entity) return undefined
      return <RelationPicker {...props} allowCreate={inline ? false : undefined} label={inline?.label} target={field.entity} field={name} value={value} selectedRow={selectedReferenceRow(model, entity, name, current)} onChange={change} error={error} />
    }} />
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
/** Instance forms and generated account actions share command writes and refreshes. */
export function useCommandMutation(props: Pick<Context, 'write' | 'onDenied'>, name: string, controls: { close: () => void; submissionKey: string }) {
  const refresh = useRefresh()
  return useMutation({ mutationFn: (data: Record<string, any>) => props.write(`/commands/${name}`, 'POST', { ...data, idempotencyKey: controls.submissionKey }), onSuccess: async () => { await refresh(); controls.close() }, onError: (error: WriteFailure) => { if (commandError(error).denied) props.onDenied?.() } })
}
export function RelationPicker(props: Context & { allowCreate?: boolean; target: string; field: string; label?: string; value: string; selectedRow?: Record<string, any>; onChange: (value: string) => void; error?: string }) {
  const { t, i18n } = useEntityTranslation(props.entity); const { model, caps, orgId, target, field, value, onChange, request } = props
  const [wizard, setWizard] = useState(false)
  const [created, setCreated] = useState<Record<string, any>>()
  const choices = usePickerSearch(model, caps, orgId, target, request)
  const { allowed, search, rows, result } = choices
  const hydrated = useSelectedReferences(model, caps, orgId, target, [value], [...rows, ...(props.selectedRow ? [props.selectedRow] : []), ...(created ? [created] : [])], request)
  const hints = model.pickerHints?.[props.entity]?.[field]
  const name = (row: Record<string, any>) => {
    const display = caps.entities[target]?.displayField ?? model.entities[target].displayField
    if (display && !caps.entities[target]?.readable.includes(display)) return recordLabel(model, target, { id: row.id }, caps, i18n.language, t)
    if (hints?.labelTemplate) return hints.labelTemplate.replace(/\{(\w+)\}/g, (_, key) => caps.entities[target]?.readable.includes(key) ? row[key] == null ? '' : formatFieldValue(row[key], model.entities[target].fields[key], i18n.language, t) : '').trim() || recordLabel(model, target, row, caps, i18n.language, t)
    return recordLabel(model, target, row, caps, i18n.language, t)
  }
  const refresh = useRefresh()
  const create = useMutation({ mutationFn: (data: Record<string, any>) => props.write(`/api/${target}`, 'POST', data, wizardKey), onSuccess: async row => { await refresh(); setCreated(row); onChange(row.id); setWizard(false); choices.close() } })
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

interface RowAccess {
  state: 'invited' | 'signed_in' | 'no_account'
  can_invite: boolean; can_cancel: boolean
  invitation?: { id: string; email: string; expires_at: string }
}
/** Status is read from the server; the protected field is never submitted by a form. */
export function GeneratedRowInvitation(props: Context & { row: Record<string, any>; disabled?: boolean }) {
  const enabled = !props.disabled && !!props.model.entities[props.entity]?.rowInvitations
  const { t } = useTranslation()
  const status = useQuery<RowAccess>({ queryKey: ['row-access', props.orgId, props.entity, props.row.id, props.caps],
    queryFn: () => props.write(`/orgs/${encodeURIComponent(props.orgId)}/row-access/${encodeURIComponent(props.entity)}/${encodeURIComponent(props.row.id)}`, 'GET'), enabled, retry: false })
  if (!enabled) return null
  if (status.error) return <span role="alert">{t('requestFailed')}</span>
  if (!status.data) return <span role="status">{t('loading')}</span>
  const data = status.data
  const pending = data.invitation
  const actions = props.disabled ? [] : data.state === 'no_account' && data.can_invite ? ['invite'] : data.state === 'invited' && pending
    ? [...(data.can_invite ? ['resend'] : []), ...(data.can_cancel ? ['cancel'] : [])]
    : data.state === 'signed_in' && props.caps.commands?.includes(`${props.entity}/remove_access`) ? ['remove'] : []
  return <div className="flex flex-wrap items-center gap-2" aria-label={t('rowAccess')}>
    <span role="status" className="text-sm">{t(`rowAccess_${data.state}`)}</span>
    {pending && <span className="text-sm break-all">{pending.email}</span>}
    {actions.map(action => <ResourceFormDialog key={action} entity={props.entity} compact
      schema={action === 'invite' ? rowInviteSchema : emptyRowSchema} trigger={t(`rowInvite_${action}`)} triggerLabel={t(`rowInvite_${action}`)}
      title={t(`rowInvite_${action}`)} description={t(action === 'remove' ? 'rowInviteRemoveDescription' : 'rowInviteDescription')} cancelLabel={t('cancel')}>
      {controls => <RowInvitationMutation {...props} action={action} invitationId={pending?.id} controls={controls} />}
    </ResourceFormDialog>)}
  </div>
}
const emptyRowSchema = { type: 'object' as const, properties: {}, additionalProperties: false }
const rowInviteSchema = { type: 'object' as const, properties: { email: { type: 'string' as const, format: 'email' } }, required: ['email'], additionalProperties: false }
function RowInvitationMutation(props: Context & { row: Record<string, any>; disabled?: boolean; action: string; invitationId?: string; controls: { close: () => void } }) {
  const { t } = useTranslation(); const refresh = useRefresh()
  const mutation = useMutation({ gcTime: 0, retry: false, mutationFn: async (values: Record<string, any>) => {
    const base = `/orgs/${encodeURIComponent(props.orgId)}/invitations`
    if (props.action === 'invite') await props.write(base, 'POST', { email: values.email, target: { entity: props.entity, row: props.row.id } })
    else if (props.action === 'resend') await props.write(`${base}/${encodeURIComponent(props.invitationId!)}/resend`, 'POST', {})
    else if (props.action === 'cancel') await props.write(`${base}/${encodeURIComponent(props.invitationId!)}`, 'DELETE')
    else await props.write(`/commands/${props.entity}/remove_access`, 'POST', { rowId: props.row.id })
    // No accept_url/credential enters the mutation cache.
  }, onSuccess: async () => { await refresh(); props.controls.close() }, onError: (error: WriteFailure) => { if (error.status === 403) props.onDenied?.() } })
  return <><WriteError error={mutation.error} /><RegistryForm schema={props.action === 'invite' ? rowInviteSchema : emptyRowSchema}
    label={() => t('email')} submitLabel={t(`rowInvite_${props.action}`)} invalidLabel={t('invalidField')} pending={mutation.isPending} disabled={props.disabled}
    onSubmit={values => mutation.mutateAsync(values)} /></>
}
