import type { GitHubConfiguration } from './github.ts'
import { Fn, Q } from '@workbasehq/core/config'
import metadata from '../package.json' with { type: 'json' }
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { Protocol } from '@modelcontextprotocol/sdk/shared/protocol.js'
import { CallToolRequestSchema, CallToolResultSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { schemas } from './schemas.ts'
import { Store } from './storage.ts'
import { Workflow } from './workflow.ts'

const descriptions = {
  bootstrap_instance: 'Write the standalone registry SDK + SST cloudflare-github template into a root inside the server root. Never overwrite existing files; report created, unchanged or conflict. No network or install.',
  list_versions: 'List local configuration history, structured diffs and read-only rollback plans. No live database reads.',
  rollback: 'Create a new local config version equal to an archived vN and generate its planner migration. No DB apply or deploy. Drops require allowDestructive. preview=true writes no config files.',
  inspect_schema: 'Inspect config, revision, validation errors with suggestedChange repairs, offline instance_meta and pending proposals, even when displayField is invalid. Does not edit config or read a live DB.',
  upgrade_sdk: 'Propose an exact, forward, same-major SDK release for a standalone Instance at baseRevision. validate and apply_to_disposable run an isolated installed target SDK. preview_migration returns current staged bytes. promote publishes exactly verified manifest, lock and marker SQL locally, preserving application files and revision. SDK submit_change is not supported.',
  propose_change: 'Membership roles: add_role {role} starts with zero grants; remove_role {role} rejects built-ins and config/target DB references; set_permissions {entity,role,operations} and set_organization_permissions {role,actions} replace grants. Role changes are config-only apart from revision bookkeeping. Propose changes at the inspected baseRevision. set_label takes entity, language (en/cs), and one or more singular/plural/object captions; object is the accusative form used by the Add button (rezervaci). For a field caption, use entity, field, language, label instead. Captions are nonempty presentation text in existing translation dictionaries; identifiers and stored records stay unchanged. set_locale takes locale and/or defaultLanguage (en/cs); defaultLanguage sets ui.defaultLanguage independently of locale. Caption/language-only changes have no schema or record migration SQL, only normal instance_meta revision bookkeeping. A computed field is read-only SQL-derived data: add_computed_field takes entity, field, definition:{type,computed}; set_computed_field takes entity, field, computed and edits only an existing computed expression. add_field also accepts definition.computed. computed is ts-query 0.15 serialize() output, never SQL. set_display_field takes entity and displayField: a readable scalar field name or serialized text expression. CONCAT uses field operands and !!!-encoded literals; ref operands (customer or customer.name) resolve scoped target values. STRFTIME takes a literal format then a date field. Subqueries use schema entity sources with qualified aliases, LIMIT 1 or aggregate, and self.id for outer correlation. Raw SQL, unknown fields/functions/nodes, cycles, type mismatches and labels consisting only of dates/numbers are rejected with suggested fixes. displayField permits at most one ref hop. Changes preserve stored data; no computed columns or destructive SQL. Then validate → preview_migration → apply_to_disposable → promote. Does not change config. Example operation: ' + JSON.stringify({ kind: 'add_computed_field', entity: 'people', field: 'full_name', definition: { type: 'string', computed: Fn.concat('first_name', Q.value(' '), 'last_name').serialize() } }),
  validate: 'Pass exactly one of {instance} to diagnose the current config, or {proposalId} to validate a proposed result. SDK proposals install and verify the exact target in an isolated consumer and save validated evidence without changing revision or application files. Returns all displayField errors as data, each with a suggestedChange for propose_change (kind: set_display_field). Choose an existing readable scalar field or a descriptive serialized expression; batch all repairs at the inspected revision. Invalid configs remain inspectable and repairable; invalid results cannot be applied or promoted. No auto-fix.',
  preview_migration: 'Preview exact planned SQL and JSON Patch over {config,indexes}. SDK proposals require current validated or verified evidence and return exact staged manifest, lock and marker bytes at the original revision. Does not deploy or mutate config.',
  apply_to_disposable: 'Apply validated SQL plus copied migrations to fresh local D1 and automatically verify tables, columns and indexes. SDK proposals perform fresh isolated target installation, validation and verification, replacing old evidence; SDK scratch is always removed, including keep=true. Config-change scratch is deleted unless keep=true. remove_role also checks the operator-configured target D1; unavailable means rejection.',
  promote: 'Only after validation and disposable verification: write reviewable files at expectedRevision. SDK proposals publish exactly the verified package.json, bun.lock and next SDK marker SQL, preserving config, history, indexes and revision. Config proposals write migration and config. Returns stale_revision (409) on conflict. Never applies to a real DB. remove_role rechecks the target D1 before writing files.',
  submit_change: 'Open or return one GitHub PR for a verified, promoted change at expectedBaseSha. Requires operator-configured GitHub access. Returns head SHA and preview/check status without waiting. Never merges, tags or deploys.',
  discard: 'Close an unpromoted proposal. Does not remove or revert an already promoted migration.',
}
export async function createServer(options: { root: string; allowed?: string[]; github?: GitHubConfiguration }) {
  const store = new Store(options.root, options.allowed ? new Set(options.allowed) : undefined)
  await store.init(true)
  const workflow = new Workflow(store, options.github)
  const inFlight = new Set<Promise<unknown>>()
  // Low-level SDK registration lets us log schema-rejected calls too, then validate every call with Zod.
  const server = new Server({ name: 'workbase', version: metadata.version }, { capabilities: { tools: {} },
    instructions: 'Use inspect_schema → propose_change → validate → preview_migration → apply_to_disposable → promote. Existing invalid configs can be inspected: validate({instance}) returns errors and suggestedChange operations; batch these into propose_change at the inspected revision. set_display_field repairs an existing entity without changing record data. Promote only writes reviewable files; human/CI applies migrations. Allowed instances: ' + [...store.allowed].join(', ') })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: Object.entries(schemas).map(([name, schema]) => ({
    name, description: descriptions[name as keyof typeof schemas], inputSchema: z.toJSONSchema(schema, { io: 'input' }) as Tool['inputSchema'],
    annotations: { readOnlyHint: ['inspect_schema', 'preview_migration', 'list_versions'].includes(name), destructiveHint: false, openWorldHint: name === 'submit_change' },
  })) }))
  // Server.setRequestHandler validates arguments before invoking us. Use the public base
  // registration so non-object arguments reach the audit, then the strict workflow schemas.
  const auditedCallSchema = CallToolRequestSchema.extend({
    params: CallToolRequestSchema.shape.params.extend({ arguments: z.unknown().optional() }),
  })
  Protocol.prototype.setRequestHandler.call(server, auditedCallSchema, async (request, extra) => {
    const call = workflow.call(request.params.name, request.params.arguments, extra.signal)
    inFlight.add(call)
    try {
      const result = await call
      return CallToolResultSchema.parse({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: result.ok === false })
    } finally { inFlight.delete(call) }
  })
  return { server, workflow, store, idle: () => Promise.allSettled([...inFlight]) }
}
