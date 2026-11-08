import { useLocation } from '@tanstack/react-router'
import { entityNavigationLabel } from './navigation'
import { useTranslation } from 'react-i18next'
import { ResourcePage } from '@workbasehq/ui'
import { useState, useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type Result } from '@workbasehq/console-generated/read'
import { GeneratedReadPage } from '@workbasehq/console-generated/screens'
import { GeneratedActions, GeneratedRowActions, GeneratedCreateDialog, HeaderCommands, resourceCreateLabel } from '@workbasehq/console-generated/writes'
import { ContextCreateAction } from '../../console-generated/src/write-screens'
import { listCommandActions } from '../../console-generated/src/write'
import { api } from './api/client'
import { useRuntimeModel, refreshRuntimeModel } from './api/runtime-model'
import { Failure, Loading, QueryError } from './screens'
export function ReadPage({ orgId, entity, id }: { orgId: string; entity: string; id?: string }) {
  const { t, i18n } = useTranslation()
  const location = useLocation()
  const [createOpen, setCreateOpen] = useState(false)
  const [createValues, setCreateValues] = useState<Record<string, string>>({})
  const createTrigger = useRef<HTMLElement | null>(null)
  useEffect(() => { setCreateOpen(false) }, [orgId, entity, id])
  const client = useQueryClient()
  // Runtime refresh unmounts this page while discarding the old authority model.
  // Keep a refused write closed across that remount, until route navigation.
  const deniedKey = ['resource-denied', orgId, entity, id ?? '']
  const denied = useQuery({ queryKey: deniedKey, queryFn: () => false, initialData: false, enabled: false, gcTime: Infinity }).data
  const runtime = useRuntimeModel(orgId)
  if (denied) return <ResourcePage title={t('forbidden')}><p>{t('resourceForbidden', { resource: t(`entity_${entity}`).toLocaleLowerCase(i18n.language) })}</p></ResourcePage>
  if (runtime.error) return <QueryError error={runtime.error} />
  if (!runtime.data) return <Loading />
  const { model, capabilities: caps, console: registry } = runtime.data
  if (!Object.hasOwn(model.entities, entity)) return <Failure kind="notFound" />
  const request = (query: import('@workbasehq/console-generated/read').ReadQuery) => api<Result>('/query', { method: 'POST', body: query, orgId })
  const mutation = { onDenied: () => { client.setQueryData(deniedKey, true); void refreshRuntimeModel(client, orgId) }, model, caps, orgId, entity, request, write: (path: string, method: string, body?: unknown, key?: string) => api(path, { method, body, orgId, idempotencyKey: key }) }
  return <><GeneratedReadPage key={`${orgId}/${entity}/${id ?? ''}/${JSON.stringify(caps)}`} {...mutation} id={id} title={t(entityNavigationLabel(registry.modelUi?.navigation, entity, (location.search as { view?: string }).view))}
    primaryAction={!id && (caps.entities[entity]?.operations.includes('create') || listCommandActions(model, entity, caps).create) ? { label: resourceCreateLabel(model, entity, i18n.language, t, caps), onAction: () => { createTrigger.current = document.activeElement as HTMLElement; setCreateValues({}); setCreateOpen(true) } } : undefined}
    calendarCreate={values => { createTrigger.current = document.activeElement as HTMLElement; setCreateValues(values); setCreateOpen(true) }}
    embeddedCreate={(target, lockedValues) => <ContextCreateAction key={`${target}/${JSON.stringify(lockedValues)}`} {...mutation} entity={target} lockedValues={lockedValues} />}
    rowActions={(row, disabled) => <GeneratedRowActions {...mutation} row={row} disabled={disabled} />}
    actions={row => row ? <GeneratedActions {...mutation} row={row} /> : <HeaderCommands {...mutation} />} />
    {<GeneratedCreateDialog initialValues={createValues} key={`${orgId}/${entity}/${JSON.stringify(caps)}`} {...mutation} open={createOpen} onOpenChange={setCreateOpen} onCloseAutoFocus={event => { if (createTrigger.current?.isConnected) { event.preventDefault(); createTrigger.current.focus() } }} />}
  </>
}
