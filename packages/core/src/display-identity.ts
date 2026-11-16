/** Supply only rows already authorized by the caller's member/inviter/issuer
 * boundary. This pure projection cannot load another user's profile or leak
 * credential, external subject, membership or synchronization metadata. */
export function displayIdentity(row: { firstName?: string | null; lastName?: string | null; name?: string | null; email?: string | null } | null) {
  const names = [row?.firstName?.trim(), row?.lastName?.trim()].filter(Boolean).join(' ')
  const legacy = row?.name?.trim()
  const email = row?.email?.trim()
  if (names) return { displayName: names, source: 'profile' as const }
  if (legacy) return { displayName: legacy, source: 'legacy_name' as const }
  if (email) return { displayName: email, source: 'email' as const }
  return { displayName: null, source: 'unavailable' as const }
}
