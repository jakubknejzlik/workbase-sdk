export type ConsoleGrant = string | { entity: string; operation?: 'read' | 'create' | 'update' | 'delete' }
export interface ConsoleGroup { id: string; label: string; order?: number; icon?: string }
export interface ConsoleNavigation {
  id: string
  placement: 'sidebar' | 'settings'
  label: string
  icon?: string
  order?: number
  group?: ConsoleGroup
  grant?: ConsoleGrant
  roles?: readonly string[]
  /** Exactly one destination; entity views reuse the generated entity route. */
  page?: string
  entity?: string
  view?: string
}
export type ConsoleAggregate = { fn: 'count' } | { fn: 'sum'; field: string }
export type ConsoleWidget = { id: string; label: string } & (
  | { kind: 'stat'; query: Pick<ConsoleQuery, 'entity' | 'where'>; aggregate: ConsoleAggregate }
  | { kind: 'table'; query: ConsoleQuery; columns: string[] }
  | { kind: 'list'; query: ConsoleQuery; field: string })
/** The SR-74 row hint, referencing widget IDs instead of detail card keys. */
export type ConsoleWidgetSection = Extract<ConsoleDetailSection, { row: string[] }>
export type ConsoleWidgetResult = Pick<ConsoleWidget, 'id' | 'label'> & (
  | { kind: 'stat'; value: number | null }
  | { kind: 'table'; columns: string[]; data: Record<string, unknown>[] }
  | { kind: 'list'; field: string; data: Record<string, unknown>[] })
export interface ConsolePageResult {
  id: string; label: string; sections?: ConsoleWidgetSection[]; widgets: ConsoleWidgetResult[]
}
export interface ConsolePage {
  id: string
  label: string
  /** Organization-relative path; renderer IDs are resolved by the shell. */
  path: string
  grant?: ConsoleGrant
  renderer?: string
  widgets?: readonly ConsoleWidget[]
  sections?: ConsoleWidgetSection[]
}
/** Wire types only: canonical model validation remains in core. No runtime imports. */
export interface ConsoleQuery {
  entity: string; select: string[]; where?: Record<string, unknown>; limit: number
  labels?: string[]
  search?: { text: string; fields: string[]; locale?: 'en' | 'cs' }
  labelWhere?: Record<string, { contains: string; locale?: 'en' | 'cs' }>
  orderBy?: { field: string; dir: 'asc' | 'desc'; label?: boolean }[]
}
export interface ConsoleFieldDisplay {
  hidden?: boolean; kind?: 'input' | 'textarea' | 'select' | 'boolean' | 'number' | 'date' | 'datetime' | 'time' | 'colour'
  span?: 'half' | 'full'; section?: string; signedBy?: { field: string; negativeValue: string }
}
/** Bounded card rows, not a component tree. `info` denotes the record information card. */
export type ConsoleDetailSection = { fields: 'info'; row?: never } | { row: string[]; fields?: never }
export type ConsoleDetailItem = string | { field: string; label?: string; help?: string; when?: { field: string; eq: string | number | boolean | null } }
/** A reusable entity list bound to the current record identity. UI hints grant no authority. */
export interface ConsoleContextList {
  entity: string; label: string; bind: { field: string; record: 'id' }
  columns?: string[]; create?: boolean
}
export interface ConsoleCalendarView { kind: 'calendar'; startField: string; endField?: string; titleField?: string; titleFields?: string[]; secondaryField?: string }
export interface ConsoleEntityDisplay {
  views?: ConsoleCalendarView[]
  lookup?: boolean
  list?: {
    columns?: string[]; search?: string[]; pageSize?: 10 | 20 | 30 | 50 | 100; compact?: boolean; mobileCards?: boolean
    relatedColumns?: Record<string, { via: string; field: string }>
    defaultSort?: { key: string; direction: 'asc' | 'desc' }
    filter?: Record<string, false | 'text' | 'enum' | 'relation' | 'number' | 'date' | 'boolean'>
    sort?: Record<string, false | { fields: string[] }>
    views?: { id: string; label: string; where: Record<string, unknown>; default?: boolean }[]
  }
  detail?: {
    /** Explicit field saves; eligibility still follows the edit form and live grants. */
    inlineEdit?: boolean
    lists?: Record<string, ConsoleContextList>
    summary?: ConsoleDetailItem[]
    groups?: { id: string; label: string; help?: string; fields: ConsoleDetailItem[] }[]
    sections?: ConsoleDetailSection[]
    fields?: string[]; metrics?: { field: string; unitField?: string; tone?: 'positive' | 'negative' }[]
    relations?: Record<string, { columns: string[]; defaultSort?: { key: string; direction: 'asc' | 'desc' } }>
  }
  fields?: Record<string, ConsoleFieldDisplay>
  form?: { create?: { fields: string[] }; edit?: { fields: string[] } }
  sections?: { id: string; label: string; fields: string[] }[]
}
export interface ConsoleModelUI {
  defaultLanguage?: 'en' | 'cs'
  entities?: Record<string, ConsoleEntityDisplay>
  navigation?: {
    routes?: { id: string; icon?: string; order?: number }[]
    groups: ConsoleGroup[]
    items: { id: string; entity: string; label?: string; icon?: string; group?: string; order?: number; roles?: string[]; view?: string; hidden?: boolean }[]
  }
}
export interface ConsoleContribution {
  navigation?: readonly ConsoleNavigation[]
  pages?: readonly ConsolePage[]
  entities?: Readonly<Record<string, ConsoleEntityDisplay>>
}
export interface ConsoleRegistry {
  navigation: ConsoleNavigation[]
  pages: ConsolePage[]
  entities: Record<string, ConsoleEntityDisplay>
  /** Model presentation hints; the console-model endpoint projects these through live grants. */
  modelUi?: ConsoleModelUI
}

/** JSON Schema 2020-12, including Workbase presentation extensions. */
export interface ConsoleInputSchema { [keyword: string]: unknown }
export interface ConsoleModelField {
  type: 'string' | 'text' | 'int' | 'float' | 'bool' | 'datetime' | 'enum' | 'ref'
  /** Storage requirement; create input presence is defined by writeSchema.required. */
  required: boolean
  nullable: boolean
  operators: string[]
  values?: string[]
  entity?: string
  default?: string | number | boolean | null
  min?: number
  readOnly?: boolean
  sensitive?: boolean
  ui?: ConsoleFieldDisplay & { format?: 'identifier' }
}
export interface ConsoleModelRelation {
  entity: string; field: string; cardinality: '1:n' | 'n:1'; quantifiers?: string[]
  through?: { entity: string; field: string; createCommand: string; deleteCommand: string }
}
export interface ConsoleModelEntity extends Omit<ConsoleEntityDisplay, 'fields'> {
  rowInvitations?: boolean
  fields: Record<string, ConsoleModelField>
  columns: string[]
  listColumns?: string[]
  listLimit: number
  displayField?: string
  labelDependencies?: { entity: string; field: string }[]
  relations: Record<string, ConsoleModelRelation>
  commandsOnly: boolean
  checks: { left: string; op: '<=' | '>='; right: string }[]
  /** Indexes emitted by the core planner, not a live database introspection. */
  indexes: { name: string; fields: string[]; unique: boolean }[]
  /** Canonical inputs projected through writable fields and the corresponding operation grant. */
  writeSchema: ConsoleInputSchema
  updateSchema: ConsoleInputSchema
  routes: { list: string; detail: string }
}
export interface ConsoleModelCommand {
  name: string
  permission: { entity: string; operation: 'read' | 'create' | 'update' | 'delete' }
  additionalPermissions: readonly ConsoleModelCommand['permission'][]
  /** Placement is presentation only; command capabilities still authorize execution. */
  ui?: { placement?: { entity: string; action: 'create' }; labelKey?: string; label?: string | { en: string; cs: string }; replacesCrud?: 'create' | 'update' | 'delete' }
  inputSchema: ConsoleInputSchema
}
export interface ConsoleRuntimeModel {
  instance: string; revision: number; displayName?: string
  locale: 'en' | 'cs'; timeZone: string; enumLabels?: Record<string, Record<string, string>>
  ui?: ConsoleModelUI
  limits: Record<string, number>
  entities: Record<string, ConsoleModelEntity>
  commands: ConsoleModelCommand[]
  workflows: { name: string; version: string; inputSchema: ConsoleInputSchema }[]
}
/** Live operation grants plus field masks. A field mask alone grants no operation. */
export interface ConsoleModelCapabilities {
  revision: number
  organization: { role: string }
  entities: Record<string, { readable: string[]; writable: string[]; operations: string[]; displayField?: string }>
  commands: string[]
  workflows: Record<string, ('start' | 'cancel' | 'resume')[]>
  resources: Record<string, boolean>
}
/** Authenticated, organization-scoped wire contract. Check version before adapting. */
export interface ConsoleModelContract {
  contractVersion: 1
  model: ConsoleRuntimeModel
  capabilities: ConsoleModelCapabilities
  console: ConsoleRegistry | null
}
