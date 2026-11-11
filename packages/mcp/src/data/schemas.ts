import { z } from 'zod'
const entity = z.string().regex(/^[a-z][a-z0-9_]*$/).max(100)
const id = z.string().regex(/^[a-zA-Z0-9_-]+$/).min(1).max(200)
const name = z.string().regex(/^[a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*)+$/).max(200)
const limit = z.number().int().min(1).max(90).optional()
const cursor = z.string().min(1).max(2000).optional()
const data = z.record(z.string(), z.json())
const input = data.refine(value => !Object.hasOwn(value, 'idempotencyKey'), 'Use the top-level idempotencyKey')
const idempotencyKey = z.string().min(1).max(128).optional()
export const schemas = {
  describe_schema: z.strictObject({}),
  // Discovery describes the document; the live HTTP compiler validates its generated grammar.
  query: z.strictObject({ entity: z.string(), select: z.array(z.string()).optional(), where: z.json().optional(), orderBy: z.array(z.json()).optional(), include: z.record(z.string(), z.json()).optional(), cursor: z.string().optional(), limit: z.number() }),
  list_records: z.strictObject({ entity, limit, cursor, filters: z.record(z.string().regex(/^[a-z][a-z0-9_]*(?:\[(?:gte|lte|gt|lt)\])?$/), z.union([z.string(), z.number(), z.boolean()])).refine(filters => !['limit', 'cursor', 'expand'].some(key => Object.hasOwn(filters, key)), 'Reserved filter').optional() }),
  get_record: z.strictObject({ entity, id }),
  create_record: z.strictObject({ entity, data, idempotencyKey }),
  update_record: z.strictObject({ entity, id, data: data.refine(value => !Object.hasOwn(value, 'version'), 'Use the top-level version'), version: z.number().int().positive() }),
  delete_record: z.strictObject({ entity, id }),
  run_command: z.strictObject({ name, input, idempotencyKey }),
  start_workflow: z.strictObject({ name, input, idempotencyKey }),
  get_workflow: z.strictObject({ id }),
  list_workflows: z.strictObject({ status: z.enum(['pending', 'running', 'waiting_external', 'compensating', 'completed', 'failed', 'compensated', 'needs_attention', 'cancelled']).optional() }),
  read_audit: z.strictObject({ entity: entity.optional(), entityId: id.optional(), limit, cursor }),
  whoami: z.strictObject({}),
  row_access: z.strictObject({ entity, id }),
  invite_from_row: z.strictObject({ entity, id, email: z.email() }),
  resend_row_invitation: z.strictObject({ id }),
  cancel_row_invitation: z.strictObject({ id }),
}
export type ToolName = keyof typeof schemas
export const mutations = new Set<ToolName>(['create_record', 'update_record', 'delete_record', 'run_command', 'start_workflow', 'invite_from_row', 'resend_row_invitation', 'cancel_row_invitation'])
export const descriptions: Record<ToolName, string> = {
  describe_schema: 'Describe live entities, fields, commands, workflows, roles and grants from public GET /health and /schema. Permission: public metadata; no record access.',
  query: 'Execute the filter-object document accepted by POST /query; returns its exact data/next_cursor or error/path/cost envelope. Discover typed filters and relation caps with describe_schema. Permission: live entity/field policies and token operations through the HTTP compiler.',
  list_records: 'List one entity using keyset pagination and equality/range filters (e.g. capacity[gte]). Permission: entity.read and token operations allowlist.',
  get_record: 'Get one organization-scoped record. Permission: entity.read and token operations allowlist.',
  create_record: 'Create a record, optionally idempotently. Send only stored writable fields; omit computed/readOnly fields (discover them with describe_schema). Permission: entity.create and token operations allowlist; commandsOnly entities refused.',
  update_record: 'Update stored writable fields using the record’s current optimistic version; computed/readOnly fields must be omitted; stale versions return version_conflict. Permission: entity.update and token operations allowlist.',
  delete_record: 'Delete one record. Permission: entity.delete and token operations allowlist; commandsOnly entities refused.',
  run_command: 'Execute a registered atomic command with optional idempotency key. Permission: exact command name in token allowlist, configured command permissions and additional permissions.',
  start_workflow: 'Start a registered durable workflow with optional idempotency key. Permission: every step operation name in token allowlist and each step entity permission. Does not cancel or resume.',
  get_workflow: 'Read a workflow result and step statuses. Permission: organization access and live permissions/allowlist for every definition step.',
  list_workflows: 'List up to 100 visible workflows, optionally filtered by status. Permission: organization access; API filters runs by live step permissions.',
  read_audit: 'Read relayed audit events using keyset pagination; relay may lag. Permission: owner role plus audit.read in token allowlist. Dispatcher/viewer receive owner_required.',
  row_access: 'Read invitation/link state for one row. Permission: entity.read and invitations.read; row policies apply.',
  invite_from_row: 'Invite an email to a row as member; only acceptance writes the link. Permission: entity.create and invitations.create, subset grant and row policies.',
  resend_row_invitation: 'Resend a pending invitation, rotating its credential. Permission: invitations.create and target entity.create for row invitations.',
  cancel_row_invitation: 'Cancel a pending invitation (row or workspace). Permission: invitations.revoke.',
  whoami: 'Return verified actor, selected organization, live role and token operation allowlist (null means unrestricted). Permission: authenticated organization access.',
}
