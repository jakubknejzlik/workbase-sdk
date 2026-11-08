import { builtinPlugin } from '../builtin-source'
import type { WorkbasePlugin } from '../plugin'
/** Scope must already have passed requireScope; a client org is only a selector. */
export const tenancy: WorkbasePlugin = builtinPlugin({
  name: 'tenancy', version: '0.1.0', provides: { organizations: '1.x' }, requires: { identity: '^1' },
  policyInConfig: true,
  tableFilter: (_entity, scope) => ({ kind: 'where', predicate: { organization_id: { eq: scope.organizationId } } }),
})
