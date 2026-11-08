/** Browser-safe projections: no executable config, credentials or database bindings. */
export interface ConfigVersion {
  revision: number
  date?: string
  commit?: string
  rollbackTo?: number
  config: Record<string, unknown>
}
export interface ConfigChange {
  kind: 'entity' | 'field' | 'view' | 'config'
  path: string
  change: 'added' | 'removed' | 'changed'
  before?: unknown
  after?: unknown
}
export interface VersionHistory {
  instance: string
  currentRevision: number
  versions: {
    revision: number
    date?: string
    commit?: string
    rollbackTo?: number
    predecessor?: number
    changes: ConfigChange[]
    rollback: { sql: string; destructive: string[]; blocked: string[]; warnings: string[]; unchanged: boolean; newRevision: number }
  }[]
}
