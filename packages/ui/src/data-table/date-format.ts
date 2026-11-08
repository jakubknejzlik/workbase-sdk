/** Source date display patterns via the browser formatter; predicates use local calendar days. */
export function formatCalendarDate(date: Date, pattern: string) {
  return new Intl.DateTimeFormat(document.documentElement.lang || 'en', { month: pattern.startsWith('MMMM') ? 'long' : 'short', day: 'numeric', year: 'numeric' }).format(date)
}
