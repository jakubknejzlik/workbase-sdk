/** Percent encoding prevents a component from introducing another tenant/path segment. */
export const segment = (value: string) => encodeURIComponent(value)
export const auditPrefix = (org: string, instance: string) => `org/${segment(org)}/i/${segment(instance)}/`
export function timeKey(occurredAt: string) {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(occurredAt) || new Date(occurredAt).toISOString() !== occurredAt) throw new Error('invalid_audit_timestamp')
  return occurredAt.replace(/\D/g, '')
}
export const sortKey = (at: string, id: string) => `${timeKey(at)}/${segment(id)}`
export interface AuditMetadata { occurred_at: string; event_id: string; entity: string; entity_id: string }

/** KV has no start/end option. Cover an inclusive timestamp interval with disjoint,
 * ascending decimal prefixes; no list request can visit a timestamp outside it. */
export function timePrefixes(from?: string, to?: string): string[] {
  let start = BigInt(from ? timeKey(from) : '00000000000000000')
  const end = BigInt(to ? timeKey(to) : '99999999999999999')
  const prefixes: string[] = []
  while (start <= end) {
    let size = 1n; let digits = 0
    while (digits < 17 && start % (size * 10n) === 0n && start + size * 10n - 1n <= end) { size *= 10n; digits++ }
    prefixes.push(start.toString().padStart(17, '0').slice(0, 17 - digits))
    start += size
  }
  return prefixes
}
