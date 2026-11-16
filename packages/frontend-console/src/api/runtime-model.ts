import { useQuery, type QueryClient } from '@tanstack/react-query'
import type { ConsoleModelContract } from '@workbasehq/core/console-contract'
import { api } from './client'
import { adaptConsoleModel } from './adapt-console-model'
export { adaptConsoleModel, type RuntimeConsole } from './adapt-console-model'

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
