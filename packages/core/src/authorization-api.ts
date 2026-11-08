// Public authorization surface. Account-scope construction stays inside core.
export { resolveActor, requireScope, authorizeOperation, scopeMiddleware } from './authorization'
export type { AvailableOrganization, ResolvedActor } from './authorization'
