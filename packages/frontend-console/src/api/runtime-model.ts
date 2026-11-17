import { useQuery, useQueryClient, type QueryClient, type QueryFunctionContext } from '@tanstack/react-query'
import type { ConsoleModelContract } from '@workbasehq/core/console-contract'
import { authorityGeneration, authorityKey, discardAuthority, parseConsoleCapabilities, useAuthorityGeneration } from './authority'
import { api } from './client'
import { adaptConsoleModel } from './adapt-console-model'
export { adaptConsoleModel, type RuntimeConsole } from './adapt-console-model'

export const runtimeModelOptions = (orgId: string) => ({
  queryKey: ['console-model', orgId], staleTime: 0, gcTime: 0, retry: false as const,
  queryFn: async ({ client, signal }: QueryFunctionContext) => {
    const generation = authorityGeneration(client, orgId)
    try {
      const document = await api<ConsoleModelContract>(`/o/${encodeURIComponent(orgId)}/console-model`, { orgId, signal })
      signal.throwIfAborted()
      if (generation !== authorityGeneration(client, orgId)) throw new DOMException('Superseded authority', 'AbortError')
      parseConsoleCapabilities(document.capabilities)
      const next = adaptConsoleModel(document)
      const previous = client.getQueryData<ReturnType<typeof adaptConsoleModel>>(['console-model', orgId])
      if (previous && authorityKey(previous.capabilities) !== authorityKey(document.capabilities)) discardAuthority(client, orgId)
      return { ...next, authorityGeneration: authorityGeneration(client, orgId) }
    } catch (error) {
      if (!signal.aborted && generation === authorityGeneration(client, orgId) && client.getQueryData(['console-model', orgId])) discardAuthority(client, orgId)
      throw error
    }
  },
})
export function useRuntimeModel(orgId?: string) {
  const client = useQueryClient(), generation = useAuthorityGeneration(client, orgId ?? '')
  const result = useQuery({ ...runtimeModelOptions(orgId!), enabled: !!orgId, refetchOnMount: false, refetchOnWindowFocus: 'always', refetchInterval: 30_000 })
  return { ...result, authorityGeneration: generation, data: result.data && (result.data.authorityGeneration ?? 0) === generation ? result.data : undefined }
}
/** Publish fresh authority without remounting the runtime host on successful refresh.
 * Refetch errors still reach consumers immediately, which render fail-closed UI. */
export async function refreshRuntimeModel(client: QueryClient, orgId: string) {
  await client.cancelQueries({ queryKey: ['console-model', orgId] })
  await client.invalidateQueries({ queryKey: ['console-model', orgId], refetchType: 'all' })
}
