// Log IDs and numeric measurements, never request/event payloads or arbitrary free text.
const messages = { 'ops.relay.run': 'Relay completed', 'ops.relay.failed': 'Relay failed', 'admin.page': 'Admin page served' } as const
export type LogEvent = keyof typeof messages
export interface LogIds { stage: string; correlationId?: string; organizationId?: string; route?: string }
export type Measurements = Record<string, number | boolean | null>
const pageRoutes = new Set(['/admin', '/admin/login', '/admin/o/:orgId/*', '/auth/sign-in/magic-link', '/auth/logout'])
const safeId = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : undefined
export function createLogger(ids: LogIds, write: (line: string) => void = console.log) {
  return (level: 'info' | 'error', event: LogEvent, data?: Measurements) => {
    if (!Object.hasOwn(messages, event)) return
    const measurements = Object.fromEntries(Object.entries(data ?? {}).filter(([key, value]) =>
      !/token|password|email|payload|secret|authorization/i.test(key) && /^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)
      && (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))))
    write(JSON.stringify({ level, event, stage: safeId(ids.stage) ?? 'unknown', message: messages[event], ts: new Date().toISOString(),
      ...(safeId(ids.correlationId) ? { correlationId: ids.correlationId } : {}),
      ...(safeId(ids.organizationId) ? { organizationId: ids.organizationId } : {}),
      ...(ids.route && pageRoutes.has(ids.route) ? { route: ids.route } : {}),
      ...(Object.keys(measurements).length ? { data: measurements } : {}),
    }))
  }
}
