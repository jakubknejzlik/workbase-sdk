import { useQuery, type QueryClient } from '@tanstack/react-query'
import type { ConsoleModelContract, ConsoleRegistry } from '@workbasehq/core/console-contract'
import type { Model } from '@workbasehq/console-generated/read'
import { api } from './client'

export interface RuntimeConsole extends Omit<ConsoleModelContract, 'model' | 'console'> { model: Model & ConsoleModelContract['model']; console: ConsoleRegistry }
/** Consume only the authenticated, sanitized projection. Never supplement it from /schema. */
export function adaptConsoleModel(document: ConsoleModelContract): RuntimeConsole {
  if (document.contractVersion !== 1) throw new Error('Unsupported console contract')
  const { model, capabilities } = document
  const registry: ConsoleRegistry = document.console ?? {
    navigation: Object.keys(model.entities).filter(entity => capabilities.entities[entity]?.operations.includes('read') && capabilities.entities[entity].readable.includes('id')).map(entity => ({ id: `entity.${entity}`, entity, label: `entity_${entity}`, placement: 'sidebar' })),
    pages: [], entities: {}, modelUi: model.ui,
  }
  // The registry in this document is already sanitized by the contract endpoint.
  const entities = Object.fromEntries(Object.entries(model.entities).map(([name, definition]) => {
    const overlay = registry.entities[name]
    return [name, { ...definition, ...overlay,
      fields: Object.fromEntries(Object.entries(definition.fields).map(([field, spec]) => [field, { ...spec, ui: { ...(overlay?.fields?.[field] ?? spec.ui), ...(['id', 'organization_id', 'created_at', 'updated_at', 'version'].includes(field) ? { hidden: true as const } : {}) } }])),
    }]
  }))
  return { ...document, model: { ...model, entities, limits: model.limits as Model['limits'], commands: model.commands.map(command => ({ ...command, additionalPermissions: [...command.additionalPermissions] })) }, console: registry }
}
export const runtimeModelOptions = (orgId: string) => ({
  queryKey: ['console-model', orgId], staleTime: 0, gcTime: 0, retry: false as const,
  queryFn: async () => adaptConsoleModel(await api<ConsoleModelContract>(`/o/${encodeURIComponent(orgId)}/console-model`, { orgId })),
})
export function useRuntimeModel(orgId?: string) {
  return useQuery({ ...runtimeModelOptions(orgId!), enabled: !!orgId, refetchOnMount: false, refetchOnWindowFocus: 'always', refetchInterval: 30_000 })
}
/** An authority signal discards the old projection before refreshing it. */
export async function refreshRuntimeModel(client: QueryClient, orgId: string) {
  await client.cancelQueries({ queryKey: ['console-model', orgId] })
  await client.resetQueries({ queryKey: ['console-model', orgId] })
}
