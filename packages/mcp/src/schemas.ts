import { z } from 'zod'
// Shared exact SemVer contract; keep CLI init schema dependencies self-contained.
export const exactVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

export const identifier = z.string().min(1).max(63).regex(/^[a-z][a-z0-9_]*$/)
  .refine(s => !['__proto__', 'prototype', 'constructor'].includes(s), 'Reserved identifier')
function identifierRecord<T extends z.ZodType>(valueSchema: T) {
  return z.unknown().superRefine((raw, ctx) => {
    // Zod records skip __proto__ before validating keys, so check the original own names first.
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return
    for (const key of Object.getOwnPropertyNames(raw)) {
      const result = identifier.safeParse(key)
      if (!result.success) ctx.addIssue({ code: 'invalid_key', origin: 'record', path: [key], issues: result.error.issues })
    }
  }).pipe(z.record(identifier, valueSchema))
}
const serializedExpressionSchema = z.union([z.string().min(1).max(32000), z.record(z.string(), z.unknown()).transform(value => JSON.stringify(value))])
const instance = z.string().max(100).regex(/^[a-z][a-z0-9-]*$/)
const revision = z.number().int().positive()
const proposalId = z.uuid()
// Deliberately narrower than core: no rule/check, command, backfill or readOnly editing.
export const fieldInput = z.strictObject({
  computed: serializedExpressionSchema.optional().describe('Serialized ts-query expression; schema fields only, no raw SQL. Automatically read-only; no stored column.'),
  type: z.enum(['string', 'text', 'int', 'float', 'bool', 'datetime', 'enum', 'ref']),
  required: z.boolean().optional(),
  default: z.union([z.string().max(10000), z.number().finite(), z.boolean(), z.null()]).optional(),
  values: z.array(z.string().max(1000)).min(1).max(100).optional(),
  entity: identifier.optional(),
})
// Kept in parity with core by membership-roles.test; CLI init must not load core.
const organizationActions = ['organizations.update', 'members.read', 'members.update', 'members.remove', 'invitations.create', 'invitations.read', 'invitations.revoke', 'tokens.create', 'tokens.read', 'tokens.revoke'] as const
const operations = z.array(z.enum(['read', 'create', 'update', 'delete'])).max(4)
const policyInput = z.union([
  z.literal('all'), z.literal('none'),
  z.strictObject({
    where: z.record(z.string(), z.unknown()),
    deny: z.enum(['empty', 'forbidden']).optional(),
    fields: z.array(identifier).optional(),
  }),
])
const caption = z.string().max(1000).refine(value => value.trim().length > 0, 'Caption must not be empty')
// Match core's supported console locales without loading core during CLI init.
const consoleLocaleSchema = z.enum(['en', 'cs'])
const setLabel = z.strictObject({
  kind: z.literal('set_label'), entity: identifier, language: consoleLocaleSchema,
  singular: caption.optional(), plural: caption.optional(), object: caption.optional().describe('Object/accusative form for the Add button, e.g. rezervaci'),
  field: identifier.optional(), label: caption.optional(),
}).refine(change => change.field !== undefined
  ? change.label !== undefined && change.singular === undefined && change.plural === undefined && change.object === undefined
  : change.label === undefined && [change.singular, change.plural, change.object].some(value => value !== undefined),
'Provide entity singular/plural/object captions, or field and label; do not mix the targets')
const setLocale = z.strictObject({
  kind: z.literal('set_locale'), locale: consoleLocaleSchema.optional(), defaultLanguage: consoleLocaleSchema.optional(),
}).refine(change => change.locale !== undefined || change.defaultLanguage !== undefined, 'Provide locale and/or defaultLanguage')
export const changeSchema = z.discriminatedUnion('kind', [
  setLabel,
  setLocale,
  z.strictObject({ kind: z.literal('add_role'), role: identifier }),
  z.strictObject({ kind: z.literal('remove_role'), role: identifier }),
  z.strictObject({ kind: z.literal('set_permissions'), entity: identifier, role: identifier, operations }),
  z.strictObject({ kind: z.literal('set_organization_permissions'), role: identifier, actions: z.array(z.enum(organizationActions)).max(organizationActions.length) }),
  z.strictObject({ kind: z.literal('add_entity'), entity: identifier, fields: identifierRecord(fieldInput),
    displayField: serializedExpressionSchema.optional(),
    permissions: identifierRecord(operations).optional(),
    policies: identifierRecord(policyInput).optional() }),
  z.strictObject({ kind: z.literal('set_policy'), entity: identifier, role: identifier, policy: policyInput }),
  z.strictObject({ kind: z.literal('set_display_field'), entity: identifier,
    displayField: serializedExpressionSchema.describe('Existing readable scalar field name, or serialized ts-query expression returning descriptive text. Use Fn.concat(date, separator, ref-name). No raw SQL; at most one ref hop; dates/numbers alone are invalid. Metadata only, preserves records.') }),
  z.strictObject({ kind: z.literal('add_field'), entity: identifier, field: identifier, definition: fieldInput }),
  z.strictObject({ kind: z.literal('add_computed_field'), entity: identifier, field: identifier, definition: fieldInput.extend({ computed: serializedExpressionSchema }) }),
  z.strictObject({ kind: z.literal('set_computed_field'), entity: identifier, field: identifier, computed: serializedExpressionSchema }),
  z.strictObject({ kind: z.literal('rename_field'), entity: identifier, from: identifier, to: identifier }),
  z.strictObject({ kind: z.literal('add_relation'), entity: identifier, name: identifier, field: identifier, target: identifier }),
  z.strictObject({ kind: z.literal('add_user_link'), entity: identifier }),
  z.strictObject({ kind: z.literal('add_index'), entity: identifier, name: identifier, fields: z.array(identifier).min(1).max(8) }),
])
export const schemas = {
  bootstrap_instance: z.strictObject({ root: z.string().min(1).optional(), id: z.string(), target: z.literal('cloudflare-github').describe('Standalone registry SDK packages, packaged console and SST Cloudflare deployment with GitHub workflows') }),
  list_versions: z.strictObject({ instance }),
  rollback: z.strictObject({ instance, to: z.string().regex(/^v[1-9][0-9]*$/), expectedRevision: revision, allowDestructive: z.boolean().optional(), preview: z.boolean().optional() }),
  inspect_schema: z.strictObject({ instance }),
  upgrade_sdk: z.strictObject({ instance, baseRevision: revision, targetVersion: z.string().regex(exactVersion).refine(value => !/\s/.test(value)) }),
  propose_change: z.strictObject({ instance, baseRevision: revision, changes: z.array(changeSchema).min(1).max(50) }),
  validate: z.strictObject({ proposalId: proposalId.optional(), instance: instance.optional() })
    .refine(input => !!input.proposalId !== !!input.instance, 'Provide exactly one of instance or proposalId'),
  preview_migration: z.strictObject({ proposalId }),
  apply_to_disposable: z.strictObject({ proposalId, keep: z.boolean().optional() }),
  promote: z.strictObject({ proposalId, expectedRevision: revision }),
  submit_change: z.strictObject({ instance, proposalId, expectedBaseSha: z.string().regex(/^[a-f0-9]{40}$/) }),
  discard: z.strictObject({ proposalId }),
}
export type ToolName = keyof typeof schemas
export type Change = z.infer<typeof changeSchema>
export type Index = { entity: string; name: string; fields: string[] }
export class WorkflowError extends Error {
  constructor(public code: string, message: string, public status = 400, public details?: unknown) { super(message) }
}
export function fail(code: string, message: string, status = 400): never { throw new WorkflowError(code, message, status) }

export function instanceSelector(id: string) {
  if (!identifier.safeParse(id).success) fail('invalid_instance_id', 'Instance id must match ^[a-z][a-z0-9_]*$ (max 63, non-reserved)')
  const selector = id.replaceAll('_', '-')
  if (!/^[a-z][a-z0-9-]*$/.test(selector)) fail('invalid_instance_id', 'Standalone config id must map to ^[a-z][a-z0-9-]*$')
  return selector
}
