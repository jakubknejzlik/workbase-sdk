import type { ConfigChange } from './migrations/version-contract'
/** Browser-safe draft projection. No runtime config or provider credentials. */
export type ConfigPatch = (
  | { kind: 'add_enum_filter'; entity: string; field: string; values: string[] }
  | { kind: 'enable_calendar'; entity: string; startField: string }
  | { kind: 'add_list_column'; entity: string; field: string }
)[]
export interface ConfigProposal {
  proposalId: string
  baseRevision: number
  revision: number
  patch: ConfigPatch
  changes: ConfigChange[]
  plan: { sql: string; destructive: string[]; blocked: string[]; warnings: string[] }
  appliesToDatabase: false
}
