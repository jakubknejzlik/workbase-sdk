export type Worker = { id: string; name: string; user?: string }
export const workers: Worker[] = [
  { id: 'w1', name: 'Anna Nováková', user: 'anna@example.test' },
  { id: 'w2', name: 'Petr Svoboda' },
]
export const shifts = [
  { starts_at: '2026-11-13T08:00:00Z', job_id: 'Office · Karlín', booked: 2 },
  { starts_at: '2026-11-13T12:30:00Z', job_id: 'Studio · Letná', booked: 1 },
]
export function saveWorker(id: string | undefined, name: string) {
  const worker = workers.find(item => item.id === id)
  if (worker) { worker.name = name; return worker.id }
  const next = { id: `w${workers.length + 1}`, name }
  workers.push(next)
  return next.id
}
