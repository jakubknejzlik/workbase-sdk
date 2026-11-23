/** Instance instants never inherit the browser's zone. */
export function instanceTimeZone(timeZone?: string) {
  if (!timeZone) return 'UTC'
  try { new Intl.DateTimeFormat('en', { timeZone }); return timeZone } catch { return 'UTC' }
}
export function civilDate(instant: Date | string | number, zone?: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: instanceTimeZone(zone), year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant)).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}
export function shiftCivilDay(day: string, count: number): string {
  const date = new Date(`${day}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + count)
  return date.toISOString().slice(0, 10)
}
function zoneOffset(instant: number, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(instant)).map(part => [part.type, Number(part.value)]))
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second) - Math.floor(instant / 1000) * 1000
}
/** Civil wall time → instant with compatible disambiguation: earlier instant in a
 * fold, advance by the gap when nonexistent. Boundaries are converted separately,
 * so a civil day is never assumed to last 24 hours. Also shared by date filters. */
export function civilInstant(day: string, zone?: string, hour = 0, minute = 0): Date {
  const timeZone = instanceTimeZone(zone)
  const wall = Date.parse(`${day}T00:00:00Z`) + (hour * 60 + minute) * 60_000
  const offsets = new Set([-2, -1, 0, 1, 2].map(delta => zoneOffset(wall + delta * 86_400_000, timeZone)))
  const candidates = [...offsets].map(offset => wall - offset).sort((a, b) => a - b)
  const exact = candidates.filter(instant => instant + zoneOffset(instant, timeZone) === wall)
  return new Date(exact[0] ?? candidates[candidates.length - 1])
}
