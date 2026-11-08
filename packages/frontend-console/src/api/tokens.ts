import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from './client'
import { fetchCapabilities, useCapabilities } from './queries'

export interface AgentToken {
  id: string; name: string; prefix: string; role: string; operations: string[] | null
  created_at: string; expires_at: string; last_used_at: string | null; revoked_at: string | null
  issuer_active: boolean; issuer: { display_name: string } | null
}
export interface TokenInput { name: string; role: string; operations?: string[]; expires_at?: string }
const root = (orgId: string) => `/orgs/${encodeURIComponent(orgId)}/tokens`
export const tokenKey = (orgId: string) => ['api-tokens', orgId] as const
export const tokenClient = {
  list: (orgId: string) => api<{ data: AgentToken[] }>(root(orgId), { orgId }),
  create: (orgId: string, body: TokenInput) => api<{ token: string }>(root(orgId), { orgId, method: 'POST', body }),
  revoke: (orgId: string, id: string) => api<void>(`${root(orgId)}/${encodeURIComponent(id)}`, { orgId, method: 'DELETE' }),
}
export function useTokens(orgId: string) {
  const capabilities = useCapabilities(orgId)
  const allowed = capabilities.data?.resources?.['tokens.read'] === true
  const list = useQuery({ queryKey: tokenKey(orgId), queryFn: () => tokenClient.list(orgId), enabled: allowed, staleTime: 0 })
  return { capabilities, allowed, list }
}
/** Fresh grants are a UX preflight; the endpoint enforces live authority again. */
export function useTokenAction(orgId: string) {
  const client = useQueryClient()
  return async (grant: 'tokens.create' | 'tokens.revoke', action: () => Promise<void>) => {
    try {
      const caps = await client.fetchQuery({ queryKey: ['capabilities', orgId], queryFn: () => fetchCapabilities(client, orgId), staleTime: 0 })
      if (!caps.resources?.[grant]) throw new ApiError(403, 'permission_denied')
      await action()
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) void client.invalidateQueries({ queryKey: ['capabilities', orgId] })
      throw error
    }
  }
}
