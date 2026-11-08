import { useQuery, useQueryClient, type QueryClient, type QueryFunctionContext } from '@tanstack/react-query'
import { refreshRuntimeModel } from './runtime-model'
import { authDestination } from './auth-destination'
import { api, ApiError } from './client'
import type { Capabilities } from '@workbasehq/console-generated/read'
export interface ConsoleCapabilities extends Capabilities { resources?: Record<string, boolean>; workflows?: Record<string, ('start' | 'cancel' | 'resume')[]>; organization?: { role: string } }
export interface Membership { organization_id: string; name: string; role: string }
export interface Me { organizationsEnabled?: boolean; organizationCreationAllowed?: boolean; user: { id: string; email: string; name?: string } | null; memberships: Membership[]; role?: string; operations?: string[] | null }
export interface Build { sha: string; builtAt: string; revision: number }
export const meOptions = { queryKey: ['me'], queryFn: () => api<Me>('/me'), staleTime: Infinity }
export const useMe = () => useQuery(meOptions)
// Organizations are a projection of /me, never a second local store.
export const useOrganizations = () => useQuery({ ...meOptions, select: (me: Me) => me.memberships })
export const organizationOptions = (orgId: string) => ({
  queryKey: ['organization', orgId], staleTime: 0,
  queryFn: async ({ client }: QueryFunctionContext) => {
    try {
      const next = await api<Me>('/me?scope=organization', { orgId })
      const previous = client.getQueryData<Me>(['organization', orgId])
      const caps = client.getQueryData<ConsoleCapabilities>(['capabilities', orgId])
      // Existing screen polls and action preflights signal authority changes.
      // Refresh the sidebar's projection without adding probes to the shell.
      const authorityChanged = previous && (previous.role !== next.role || JSON.stringify(previous.operations) !== JSON.stringify(next.operations))
      if (authorityChanged || caps?.organization && caps.organization.role !== next.role) {
        await client.invalidateQueries({ queryKey: ['capabilities', orgId] })
      }
      return next
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) await client.invalidateQueries({ queryKey: ['capabilities', orgId] })
      const destination = await removedMembershipDestination(client, orgId, error)
      if (destination) window.location.replace(destination)
      throw error
    }
  },
})
export const useOrganization = (orgId: string) => useQuery({ ...organizationOptions(orgId), enabled: !!orgId, refetchOnMount: 'always', refetchOnWindowFocus: 'always', refetchInterval: 2_000 })
export function useBuild() {
  const client = useQueryClient()
  return useQuery({
    queryKey: ['build'],
    queryFn: async () => {
      const next = await api<Build>('/build.json')
      const previous = client.getQueryData<Build>(['build'])
      if (previous && previous.revision !== next.revision) window.location.reload()
      return next
    },
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  })
}
export async function fetchCapabilities(client: QueryClient, orgId: string) {
  let next: ConsoleCapabilities
  try { next = await api<ConsoleCapabilities>(`/o/${encodeURIComponent(orgId)}/capabilities`) } catch (error) {
    if (error instanceof ApiError && [401, 403].includes(error.status)) await refreshRuntimeModel(client, orgId).catch(() => {})
    throw error
  }
  const previous = client.getQueryData<ConsoleCapabilities>(['capabilities', orgId])
  if (previous && previous.revision !== next.revision) {
    window.sessionStorage.setItem('console-schema-reloaded', '1')
    window.location.reload()
  }
  if (previous && JSON.stringify(previous) !== JSON.stringify(next)) await refreshRuntimeModel(client, orgId)
  return next
}
export function useCapabilities(orgId?: string) {
  const client = useQueryClient()
  return useQuery({ queryKey: ['capabilities', orgId], queryFn: () => fetchCapabilities(client, orgId!), enabled: !!orgId,
    refetchInterval: 30_000, refetchOnMount: false, refetchOnWindowFocus: true })
}

/** Only a failed scope read followed by fresh Me can prove membership loss.
 * Operation refusals never call this recovery. The account/profile stay intact. */
export async function removedMembershipDestination(client: QueryClient, orgId: string, error: unknown) {
  if (!(error instanceof ApiError) || error.status !== 403) return
  let me: Me
  try { me = await api<Me>('/me') } catch { return }
  client.setQueryData(['me'], me)
  if (!me.user || me.memberships.some(item => item.organization_id === orgId)) return
  client.removeQueries({ queryKey: ['workspace-identity', orgId] })
  client.removeQueries({ queryKey: ['bootstrap'], type: 'inactive' })
  return authDestination(null, me.memberships)
}
