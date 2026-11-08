import type { ConsoleRegistry } from './console'
import type { QueryClient } from '@tanstack/react-query'
import { api, ApiError } from './client'
import { profileOptions } from './profile'
import { removedMembershipDestination, type Build, type ConsoleCapabilities, type Me } from './queries'
import { runtimeModelOptions } from './runtime-model'
import { instanceOptions, type InstanceSchema } from './identity'

interface Bootstrap { console?: ConsoleRegistry; schema: InstanceSchema; capabilities?: ConsoleCapabilities; me: Me; build: Build }
export const isBootstrappedRoute = (path: string) => path === '/' || path === '/auth/complete' || path === '/organizations' || path.startsWith('/o/') || path.startsWith('/settings')
/** Cached only in this session's QueryClient; logout clears it with the other projections. */
export function bootstrapOptions(client: QueryClient, orgId?: string) {
  return { queryKey: ['bootstrap', orgId], staleTime: Infinity, gcTime: Infinity, refetchOnWindowFocus: false,
    queryFn: async () => {
      let data: Bootstrap
      try {
        const [schema, me, build, runtime] = await Promise.all([
          client.ensureQueryData(instanceOptions), api<Me>('/me', { redirect401: window.location.pathname !== '/' }),
          api<Build>('/build.json'), orgId ? client.fetchQuery(runtimeModelOptions(orgId)) : undefined,
        ])
        data = { schema, me, build, capabilities: runtime?.capabilities, console: runtime?.console }
        if (orgId && runtime) client.setQueryData(['workflow-schema', orgId], runtime.model)
      }
      catch (error) {
        if (orgId && error instanceof ApiError && error.status === 403) {
          // ProfileGate owns onboarding while the parallel bootstrap is denied.
          const profile = await client.ensureQueryData(profileOptions).catch(() => undefined)
          if (!profile?.completeness.complete) {
            // A denied organization has no bootstrap schema; onboarding still needs public branding/locale.
            if (profile) await client.ensureQueryData(instanceOptions).catch(() => undefined)
            throw error
          }
        }
        const destination = orgId && await removedMembershipDestination(client, orgId, error)
        if (destination) window.location.replace(destination)
        throw error
      }
      const previousBuild = client.getQueryData<Build>(['build'])
      const previousCaps = orgId ? client.getQueryData<ConsoleCapabilities>(['capabilities', orgId]) : undefined
      if (previousBuild && previousBuild.revision !== data.build.revision || previousCaps && previousCaps.revision !== data.capabilities?.revision) {
        window.sessionStorage.setItem('console-schema-reloaded', '1')
        window.location.reload()
      }
      client.setQueryData(['instance'], data.schema)
      client.setQueryData(['me'], data.me)
      client.setQueryData(['build'], data.build)
      if (orgId) client.setQueryData(['console-registry', orgId], data.console ?? { navigation: [], pages: [], entities: {} })
      if (orgId && data.capabilities) client.setQueryData(['capabilities', orgId], data.capabilities)
      return data
    } }
}
