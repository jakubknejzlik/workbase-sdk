// Captured against main 776f1b2's crud.ts with insertDomain(), active=true and
// memo='x'.repeat(2001). IDs, statuses, errors and raw REST cursors are stable.
export const legacyRestFixtures: { name: string; entity: string; params: Record<string, string>; status: number; error?: string; ids?: string[] }[] = [
  { name: 'zero limit', entity: 'clients', params: { limit: '0' }, status: 400, error: 'invalid_limit' },
  { name: 'oversized limit', entity: 'clients', params: { limit: '1000' }, status: 400, error: 'invalid_limit' },
  { name: 'unknown field', entity: 'clients', params: { unknown: '1' }, status: 400, error: 'unknown_filter' },
  { name: 'raw cursor', entity: 'clients', params: { cursor: 'garbage' }, status: 200, ids: [] },
  { name: 'unknown expansion', entity: 'clients', params: { expand: 'unknown' }, status: 400, error: 'unknown_expansion' },
  { name: 'fractional int bound', entity: 'slots', params: { 'capacity[gte]': '1.5' }, status: 200, ids: ['slot-org-a'] },
  { name: 'fractional int equality', entity: 'slots', params: { capacity: '1.5' }, status: 200, ids: [] },
  { name: 'boolean range', entity: 'clients', params: { 'active[gte]': 'false' }, status: 200, ids: ['client-org-a'] },
  { name: 'boolean equality', entity: 'clients', params: { active: 'true' }, status: 200, ids: ['client-org-a'] },
  { name: 'long text', entity: 'clients', params: { memo: 'x'.repeat(2001) }, status: 200, ids: ['client-org-a'] },
  { name: 'long string', entity: 'clients', params: { name: 'x'.repeat(2001) }, status: 200, ids: [] },
  { name: 'hostile string', entity: 'clients', params: { name: "'; -- ; 雪 💣" }, status: 200, ids: [] },
]
