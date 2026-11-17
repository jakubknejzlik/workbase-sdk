/** Curated public HTTP contracts. No runtime handler imports or configuration spreads. */
export type Schema = Record<string, any>
export const string = { type: 'string' }
export const boolean = { type: 'boolean' }
export const array = (items: Schema): Schema => ({ type: 'array', items })
export const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: 'null' }] })
export const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` })
export const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({ type: 'object', properties, required: [...required].sort(), additionalProperties: false })
export const response = (schema: Schema, description = 'Success'): Schema => ({ description, content: { 'application/json': { schema } } })
export const request = (schema: Schema): Schema => ({ required: true, content: { 'application/json': { schema } } })
export const parameter = (name: string, location: string, schema: Schema, required = false): Schema => ({ name, in: location, required, schema })
export const operation = (responses: Schema, extra: Schema = {}): Schema => ({ security: [{ session: [] }, { bearer: [] }], responses: { default: response(ref('Error'), 'API error'), ...responses }, ...extra })
const map = (schema: Schema): Schema => ({ type: 'object', additionalProperties: schema })
const strings = array(string)
const account = object({ id: string, display_name: string, email: string })
const invitation = object({ id: string, email: string, expires_at: string })
const org = object({ id: string, name: nullable(string) })
const target = object({ entity: string, row: nullable(string) })
const metadata = { id: string, organization: org, inviter: object({ display_name: string }), role: string, expires_at: string, target,
  state: { type: 'string', enum: ['pending', 'expired', 'accepted', 'declined', 'revoked'] }, account_match: nullable(boolean) }
const metadataRequired = Object.keys(metadata).filter(key => key !== 'target')
const preview = object({ ...metadata, navigation_target: string, return_to: string, profile_complete: boolean, next: { type: 'string', enum: ['terminal', 'preview', 'profile'] }, actions: strings }, [...metadataRequired, 'navigation_target', 'return_to', 'profile_complete', 'next', 'actions'])
const profile = object({ id: string, email: string, firstName: nullable(string), lastName: nullable(string), displayName: nullable(string),
  authority: object({ kind: { type: 'string', enum: ['local', 'idp'] }, provider: nullable(string), synchronization: nullable(object({ method: string, maxLatencySeconds: { type: 'integer', minimum: 0 } })) }),
  capabilities: object({ canEditNames: boolean, canEditEmail: { type: 'boolean', enum: [false] } }),
  completeness: object({ complete: boolean, missingFields: array({ type: 'string', enum: ['firstName', 'lastName'] }) }), syncedAt: nullable(string),
})
const member = object({ user_id: string, email: string, role: string, display_name: string })
const linkCandidate = object({ ...member.properties, linkable: boolean, link_reason: { type: 'string', enum: ['account_already_linked', 'account_not_linkable'] } }, [...Object.keys(member.properties), 'linkable'])
const memberPending = object({ ...member.properties, display_name: string, last_administrator: boolean, kind: { type: 'string', enum: ['member'] }, status: { type: 'string', enum: ['active'] }, actions: strings })
const invited = object({ target_entity: nullable(string), target_row: nullable(string), id: string, email: string, role: string, expires_at: string, created_at: nullable(string), inviter: object({ display_name: string }), kind: { type: 'string', enum: ['invitation'] }, status: { type: 'string', enum: ['pending'] }, actions: strings })
const revision = object({ revision: { type: 'integer' }, coreVersion: string, migrations: string, pluginMigrations: string }, ['revision', 'coreVersion', 'migrations'])
const health = object({ instance: string, revision: { type: 'integer' }, core_version: string, schema: object({ enabled: boolean, compatible: boolean, expected: nullable(revision), applied: nullable(revision) }) })
const tokenBody = object({ token: string, return_to: string }, ['token'])
const returnBody = object({ return_to: string }, [])
const me = object({ organizationsEnabled: boolean, organizationCreationAllowed: boolean,
  user: nullable(object({ id: string, email: string, name: string }, ['id', 'email'])),
  actor: object({ type: { type: 'string', enum: ['user', 'agent', 'service'] }, id: string, tokenId: string }, ['type', 'id']),
  memberships: array(object({ organization_id: string, name: string, role: string })),
  organization_id: string, role: string, operations: strings,
}, ['organizationsEnabled', 'organizationCreationAllowed', 'user', 'actor', 'memberships'])

export function publicPaths(): Record<string, Schema> {
  return {
    '/me': { get: operation({ '200': response(me) }, { parameters: [parameter('scope', 'query', { type: 'string', enum: ['organization'] }), parameter('X-Organization-Id', 'header', string)] }) },
    '/o/{org}/capabilities': { parameters: [parameter('org', 'path', string, true)], get: operation({ '200': response(ref('Capabilities')) }) },
    '/orgs/{orgId}/members': { parameters: [parameter('orgId', 'path', string, true)], get: operation({ '200': response({ oneOf: [object({ data: array({ oneOf: [member, linkCandidate] }) }), object({ data: array({ oneOf: [memberPending, invited] }), role_options: array(object({ id: string, administrator: boolean })), default_role: string }, ['data', 'role_options'])] }) }, { parameters: [parameter('include', 'query', { type: 'string', enum: ['pending'] }), parameter('q', 'query', { type: 'string', maxLength: 200, description: 'Optional literal name/email search for eligible=link_account; all whitespace-separated tokens must match (at most 20).' }), parameter('eligible', 'query', { type: 'string', enum: ['link_account'] }), parameter('target_entity', 'query', { type: 'string', pattern: '^[a-z][a-z0-9_]*$', description: 'Required for eligible=link_account; configured entity with a user link.' }), parameter('target_row', 'query', { type: 'string', minLength: 1, maxLength: 200, description: 'Required for eligible=link_account; visible, writable row in this organization.' })], description: 'Link eligibility requires an administrator with members.read, target_entity and target_row plus Link authority. Missing, malformed or inaccessible targets return 400 invalid_link_target. Without q, results exclude accounts linked to another row of that entity in this organization. With q, matching members include linkable and, when unavailable, link_reason; unavailable accounts cannot be linked.' }) },
    '/me/invitations': { get: operation({ '200': response(object({ data: array(object({ ...metadata, navigation_target: string }, [...metadataRequired, 'navigation_target'])), next: string })) }, { parameters: [parameter('return_to', 'query', string)] }) },
    '/orgs/{orgId}/invitations': { parameters: [parameter('orgId', 'path', string, true)], post: operation({
      '200': response(object({ message: { type: 'string', enum: ['already_member'] } })),
      '201': response(object({ ...invitation.properties, role: string, accept_url: string, delivery: object({ status: string, attempts: { type: 'integer' }, sent_at: nullable(string), error: nullable(string) }) })),
      '409': response(object({ error: { type: 'string', enum: ['account_already_linked', 'invitation_pending', 'invitation_conflict'] } }), 'Invitation conflict'),
    }, { requestBody: request(object({ email: { type: 'string', format: 'email' }, role: string, target: object({ entity: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' }, row: { type: 'string', minLength: 1, maxLength: 200 } }), profile_prefill: object({ firstName: string, lastName: string }, []) }, ['email'])),
      description: 'Creates an invitation. A row target derives its role from the configured entity. Returns 409 account_already_linked if the target is occupied or the known invitee is already linked to another row of the same entity in this organization. The uniqueness check is repeated atomically when inserting the invitation; unknown addresses and links to different entities or organizations are allowed.' }) },
    '/invitations/preflight': { post: operation({ '200': response(object(metadata, metadataRequired)) }, { security: [], requestBody: request(tokenBody) }) },
    '/invitations/resolve': { post: operation({ '200': response(preview) }, { security: [], requestBody: request(tokenBody) }) },
    '/invitations/{id}/resolve': { parameters: [parameter('id', 'path', string, true)], post: operation({ '200': response(preview) }, { requestBody: request(returnBody) }) },
    ...Object.fromEntries(['accept', 'decline'].map(action => [`/invitations/{id}/${action}`, { parameters: [parameter('id', 'path', string, true)], post: operation({
      '200': response(object({ id: string, state: { type: 'string', enum: [action === 'accept' ? 'accepted' : 'declined'] }, replayed: boolean, organization_id: string, role: string, entry_target: string }, ['id', 'state', 'replayed'])),
      ...(action === 'accept' ? { '201': response(object({ id: string, state: { type: 'string', enum: ['accepted'] }, replayed: boolean, organization_id: string, role: string, entry_target: string })) } : {}),
    }, { requestBody: { ...request(returnBody), required: false } }) }])),
    '/me/profile': { get: operation({ '200': response(profile) }), patch: operation({ '200': response(profile) }, { requestBody: request(object({ firstName: { type: 'string', minLength: 1, maxLength: 200 }, lastName: { type: 'string', minLength: 1, maxLength: 200 } })) }) },
    '/auth/providers': { get: operation({ '200': response(object({ providers: array(object({ id: string })) })) }, { security: [] }) },
    '/auth/logout': { post: operation({ '204': { description: 'Signed out' } }) },
    '/auth/sign-in/magic-link': { post: operation({ '200': response({}, 'Opaque authentication-provider response'), default: response({}, 'Opaque authentication-provider response') }, { security: [], requestBody: request(object({ email: { type: 'string', format: 'email' }, callbackURL: string, name: string }, ['email'])) }) },
    '/build.json': { get: operation({ '200': response(object({ sha: string, builtAt: string, revision: { type: 'integer' }, openapi: string })) }, { security: [] }) },
    '/health': { get: operation({ '200': response(health), '503': response(health, 'Schema incompatible') }, { security: [] }) },
    '/openapi.json': { get: operation({ '200': response({ type: 'object' }), '503': response(object({ error: { type: 'string', enum: ['openapi_not_bound'] } }), 'OpenAPI artifact is not bound') }, { security: [], description: 'Serves the committed public specification anonymously. Returns 503 when no valid OpenAPI artifact is bound.' }) },
  }
}
publicPaths.schemas = {
  Error: { type: 'object', properties: { error: string, hint: string, reason: string }, required: ['error'], additionalProperties: true },
  AccountAccess: object({ state: { type: 'string', enum: ['no_account', 'invited', 'expired', 'linked'] }, account: nullable(account), invitation: nullable(invitation) }),
  Capabilities: object({ revision: { type: 'integer' }, entities: map(object({ readable: strings, writable: strings, operations: array({ type: 'string', enum: ['read', 'create', 'update', 'delete'] }), displayField: string }, ['readable', 'writable', 'operations'])),
    commands: strings, workflows: map(array({ type: 'string', enum: ['start', 'cancel', 'resume'] })), resources: map(boolean), organization: object({ role: string }),
  }),
}
