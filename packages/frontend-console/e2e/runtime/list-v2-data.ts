/** Synthetic, fixed seed and independent acceptance oracle. No UI/query compiler imports. */
export const seedTime = '2026-01-15T10:00:00.000Z'
export const workers = Array.from({ length: 47 }, (_, index) => {
  const n = index + 1
  return { id: `w${String(n).padStart(3, '0')}`, name: `Worker ${String(n).padStart(3, '0')}`, code: `W${n}`, status: n % 3 === 0 ? 'inactive' : 'active', team_id: n % 2 ? 'north' : 'south', user: n % 4 === 0 ? 'staff' : n === 3 ? 'linked' : null, access: n % 4 === 0 || n === 3 ? 'signed_in' : n === 2 ? 'invited' : n === 5 ? 'expired' : 'no_account' }
})
export type Actor = 'admin' | 'staff'
export interface Selection { actor?: Actor; view?: string; search?: string; team?: string; status?: string; access?: string }
export function expectedRows({ actor = 'admin', view = 'all', search = '', team, status, access }: Selection = {}) {
  return workers.filter(row => (actor === 'admin' || row.user === 'staff') && row.name.toLowerCase().includes(search.toLowerCase()) && (!team || row.team_id === team) && (!status || row.status === status) && (!access || row.access === access) && (view === 'all' || view === 'empty' ? view !== 'empty' : view === 'invited' ? row.access === 'invited' : row.status === view))
}
export function expectedCounts(selection: Selection = {}) {
  return Object.fromEntries(['all', 'active', 'inactive', 'empty', ...(selection.actor === 'staff' ? [] : ['invited'])].map(view => [view, expectedRows({ ...selection, view }).length]))
}
