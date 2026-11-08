import { api, ApiError } from './client'

export interface SelfProfile {
  id: string; email: string; firstName: string | null; lastName: string | null; displayName: string | null
  authority: { kind: 'local' | 'idp'; provider: string | null; synchronization: { method: string; maxLatencySeconds: number } | null }
  capabilities: { canEditNames: boolean; canEditEmail: false }
  completeness: { complete: boolean; missingFields: ('firstName' | 'lastName')[] }
  syncedAt: string | null
}
export interface ProfileNames { firstName: string; lastName: string }
export const profileOptions = { queryKey: ['profile'], queryFn: () => api<SelfProfile>('/me/profile'), staleTime: 0, retry: false as const }
export const profileClient = {
  update: (names: ProfileNames) => api<SelfProfile>('/me/profile', { method: 'PATCH', body: names }),
  rename: (orgId: string, name: string) => api<{ id: string; name: string; invalidates: string[] }>(`/organizations/${encodeURIComponent(orgId)}`, { orgId, method: 'PATCH', body: { name } }),
}
export const validProfileName = (value: string) => !!value.trim() && value.trim().length <= 200 && !/[\u0000-\u001f\u007f]/.test(value.trim())
export function settingsError(error: unknown) {
  if (!(error instanceof ApiError)) return 'settingsSaveFailed'
  if (error.code === 'profile_read_only') return 'profileManaged'
  if (error.status === 409) return 'settingsConflict'
  if (error.status === 400) return 'invalidName'
  if (error.status === 403) return 'forbidden'
  return 'settingsSaveFailed'
}
