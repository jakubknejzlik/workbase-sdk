# Canonical entity declarations

`@workbasehq/core/schema` supplies runtime declarations and core schema types.
`@workbasehq/core/schema/load` is a separate build-time entry: it reads source with
TypeScript's compiler API, interprets the accepted literal declarations without
importing or executing consumer modules, and returns `{ config, sources }`. Keeping the loader separate prevents Node file
APIs and the TypeScript compiler from entering the runtime declaration graph.

Use a TypeScript-capable host such as Bun or tsx for loading, as with the existing
infrastructure config imports. TypeScript is a declared core dependency for the
loader; a consumer does not need an undeclared workspace dependency.

```ts
// schema/worker.ts
import { accountLink, defineEntity } from '@workbasehq/core/schema'

export default defineEntity({
  fields: {
    name: { type: 'text', required: true },
    user: accountLink(),
  },
  displayField: 'name',
})
```

```ts
// config.ts
import { defineConfig } from '@workbasehq/core/schema'
import worker from './schema/worker.ts'

export default defineConfig({
  id: 'sample',
  roles: ['admin', 'staff'],
  organizationOwnerRole: 'admin',
  languages: ['cs', 'en'],
  entities: { worker },
})
```

```ts
// A build/check entry, run with Bun or tsx.
import { loadConfig } from '@workbasehq/core/schema/load'

const { config, sources } = await loadConfig('./config.ts')
console.log(config.entities.worker.fields.name.type) // text
console.log(sources['entities.worker.fields.name']) // { file, line, column }
```

The new entry requires an explicit, nonempty list of unique roles and an owner
role from that list. SDK permission-provider configuration must agree with those
values. It adds no implicit `owner` or `member`, and supplies no implicit
organization grants. Existing permissions/policies may be supplied in their core
form for schema-only tooling. Executing a canonical configuration requires
the explicit access declaration described below.

`languages` is a nonempty ordered list of unique language tags; its first item is
the Instance default. The loader validates and retains that order. This entry
adds no translation runtime. Entity, field and enum labels belong in
`locales/<language>/domain.json` dictionaries; inline labels are rejected.

Each entity map entry must explicitly import a default or named `defineEntity`
export from its matching `./schema/<entity>.ts` file. The config default export
is a direct `defineConfig({...})` call. Named SDK imports may use local aliases.
The loader reads exactly `schema/<entity>.ts` and rejects competing candidates
(other extensions, extensionless files, directories, case variants). Use explicit
`.ts` specifiers. Only direct SDK/entity imports and the declaration export are
accepted; side-effect imports, helper wrappers, extra exports and top-level code
are rejected. Files with syntax errors are rejected. Config options are literal
data, except for imported entity identifiers. The returned config is the branded
`defineConfig` result of that literal data, equal to the module's default export.

Scope: the loader validates the declaration *shape* that agents and authors write.
It is not a sandbox against the consumer repository's own toolchain configuration.
Module redirection configured by the repository itself (tsconfig `paths`, package
`imports`/self-reference aliases, symlinked SDK copies, `verbatimModuleSyntax`
keeping type-only imports) is trusted, as is everything else in that repository.
The entity argument is an object literal with object/array/scalar literals inside
it. Spreads, identifier values, shorthand properties, methods, accessors, computed
keys, duplicate properties and arbitrary calls are rejected, including inside
nested arrays or objects. Type assertions and `satisfies` around literals are
allowed. The one permitted call is imported SDK `accountLink()` at `fields.user`,
without arguments. Expressions use the core serialized expression format as
literal data, rather than executable query-builder calls inside the declaration.

`accountLink()` normalizes to the existing optional protected `user` ref to
`users`, with `userLink: true`, `readOnly: true` and the to-one `user_account`
relation. Generic create/update validators cannot write or clear it. The SDK adds
the minimal `users` account projection (`name`, `role`) and `account.entity` to
the normalized config. An Instance cannot declare `users` or replace account
ownership. This declaration change does not move or apply any table DDL.

The returned config is the existing kernel schema. Core `string`, `text`, `int`,
`float`, `bool`, `datetime`, `enum` and `ref` types, computed fields, display
expressions and public metadata all use that schema. `number` and `boolean` are
not schema field type aliases. Domain declarations have no plugin migrations or
`checkSchema`; SDK plugin contract checks and migrations remain available.

Source map keys use config paths, for example `entities.worker.fields.user`.
Locations use absolute filenames and one-based lines/columns. Invalid literals
and declaration values throw `SourceError` formatted as `file:line:column`.
Runtime declarations validate values on their own; source syntax checking requires
`loadConfig`, which should run before a build executes the config normally.

The existing `defineInstance` entry retains inline/shorthand declarations and its
legacy role/default-grant normalization. Import those modules through the legacy
entry; `loadConfig` accepts only canonical `defineConfig` modules. Schema and access locks are checked by their SDK CLIs.

## Authored access (option C)

Declare domain access inside `defineEntity`, next to its fields and relations.
This keeps schema and policy edits together and reuses the same literal validator
and source map. Import a direct `defineAccess({...})` export from `./access.ts`
as the config's `access` property. This shared declaration has three required maps:

- `roles`: every configured role, each with `system`, an explicit action-to-decision
  map. `accessSystemActions` exported from `@workbasehq/core/schema` lists its keys.
- `entities`: every SDK/system entity in the exported `accessEntities` list,
  including `users`. Each value is a complete role matrix, as for domain access.
- `predicates`: named literal query filters, referenced using `{ use: 'name' }`.

The exports enumerate required keys for authoring/check tools. Source declarations
must spell out their entries: generated maps, spreads and helper calls are outside
the literal boundary. `access.ts` uses the same unambiguous direct-file resolution
as entity modules, including rejecting competing extensions and extra code.

An entity's access entry for each role is either `deny`, `none`, or an object
with all four operations: `read`, `create`, `update`, `delete`. List uses `read`.
Every operation is `allow`, `none`, `deny`, or `{ where: <filter> }`. Read also
accepts `fields`, an explicit projection mask (id is retained for nonempty masks).
An omitted mask grants nonsensitive schema fields; sensitive fields require an
explicit mask. No role name grants sensitive fields automatically. SDK entities
without a schema projection accept decisions only, enforced at resource ports;
row predicates and masks require a schema projection such as `users`.

```ts
// Inside schema/worker.ts's defineEntity literal:
access: {
  admin: { read: 'allow', create: 'allow', update: 'allow', delete: 'allow' },
  staff: {
    read: { where: { use: 'linked_worker' }, fields: ['id', 'name'] },
    create: 'deny', update: 'deny', delete: 'deny',
  },
}
// Inside access.ts's predicates map:
linked_worker: { user: { eq: '$actor.id' } }
```

These synthetic roles illustrate the mechanism; they do not select a product
policy. Missing role/entity/operation/action entries are errors. `none` contributes
no grant; held roles contribute a union of grants and field masks, with any
explicit `deny` winning for that operation. Unknown roles fail closed. Credential
operation allowlists are independently enforced. Writes never grant read access,
and create/update/delete predicates are checked independently of the read filter.
Existing organization scoping and protected account-link writes still apply.

System actions require both an authored action grant and the corresponding entity
operation grant: for example `members.read` also requires `memberships.read`, and
`invitations.revoke` requires `invitations.delete`. `tokens` maps to `access_tokens`,
`audit` to `audit_events`, and `workflows` to `workflow_runs`. Default privileges
and built-in role names cannot bypass either denial. Compatibility permission
maps and SQL issuer guards are derived from these same decisions. Authored access
cannot be mixed with legacy `permissions`, `policies` or `organizationPermissions`.

Named predicates expand at build time with a maximum depth of 16 and 512 visited
values per expansion. Unused predicates are also checked. Named cycles and
operation-specific relation-policy cycles fail with their cycle path. Invalid
filters, references, masks and expansion budgets map back to file:line diagnostics.

`config.effectiveAccess` is the exported `EffectiveAccessPolicy`, available from
`@workbasehq/core/schema`. It contains canonically ordered entity/role/operation
rules with expanded filters, masks, named references, relation dependencies,
explicit decisions and system actions with their required entity/operation targets.
Masks are null for mutations and SDK resources without a schema projection. Its `source` fields are stable source-map
keys; the loader's `sources` supplies exact locations without making policy equality
depend on declaration order or machine paths. Execution consumes this representation;
slice 2b will serialize it to access locks. There is no second audit policy compiler.
The same type includes registered command permissions/additional permissions, opaque
command markers, and opaque plugin-hook names. The kernel resolves code-registered
commands during composition; serialize `kernel.config.effectiveAccess` for the
complete registry. Unresolved command names have null permissions and cannot run.
Executable prepare/plan and custom plugin checks remain enforced and marked opaque.

`loadConfig` also returns `configHash`, a SHA-256 of the config, imported entity
and shared access source paths/bytes. Policy-only edits change this hash without
altering `config.revision` or physical schema SQL. The loader binds `config.revision` from `schema.lock.json` (r1 before initialization);
`defineConfig` rejects an authored revision. Slice-1 declarations without access remain readable
by schema tools; the kernel refuses to execute them with legacy defaults.


## Physical schema lock and migration bundles

Run `bun run migrate:plan --init` with no lock or domain SQL to initialize r1.
With `--base <ref> --init`, the ref must also have no lock or domain migrations.
Subsequent plans require `--base <ref>` and compare against that ref's tip.
The adapter only reads local Git objects; fetch the desired ref before planning.
SDK/plugin DDL stays in SDK ledgers.

A schema change writes one `NNNN_rN.sql` bundle and a lock whose parent is the
SHA-256 of the exact base lock bytes. Repeated plans preserve the same bytes.
Base migration files must remain unchanged. `check:schema --base <ref>` validates
that linkage, the generated SQL, the config against the lock, and manual evidence.
Without a base, `check:schema` checks config and bundle evidence only.
The root invariant check supplies `origin/main` (or `origin/$GITHUB_BASE_REF`);
pass `--base <ref>` to override it for a stacked branch.

Bundles contain exactly one header followed by pre-data, generated, and post-data
regions in that order. Regeneration preserves manual region bytes, including line
endings. Changed generated SQL or a moved parent requires renewed manual review:
run `migrate:plan --base <ref> --confirm-manual` to record evidence in the header.
Evidence hashes decimal UTF-8 byte-length-prefixed bodies (`length:body`) in
pre/generated/post order. Editing a confirmed manual region invalidates evidence.
The migration ledger still hashes the entire file.

Regenerating against a moved base renumbers the pending bundle and rewrites its
parent. If its filename collides with a newly merged migration, the base file is
restored and the pending bundle moves to the next revision. An empty schema diff
removes a pending bundle only when both manual regions are empty.

Both commands accept `--config`, `--root`, `--directory` and `--migrations`.
Installed consumers invoke `@workbasehq/core/migrations/schema-cli` with `plan` or
`check`; repository scripts only supply paths and the CI base.
Runtime builds bind the lock with `bindSchemaLock`; direct `defineConfig`
declarations remain unbound until a lock is supplied.

Record actions are strict entity data pointing at registered commands:

```ts
actions: {
  close: {
    command: 'record/close',
    available: [{ when: { state: { eq: 'open' } }, reason: 'record.closed' }],
  },
}
```

`when` uses access predicates, including `{ use: 'name' }`. Compilation rejects
unregistered, unallowlisted and system-permission commands. Expanded conditions,
field dependencies and declaration sources live in `effectiveAccess.actions` and
both access locks; command bodies remain opaque guards. `actionReasonKeys(config)`
from `@workbasehq/core/schema` exposes the finite authored reason keys.

SDK-era detail GETs include an `actions` map, independent of projection. Forbidden
or masked-dependency actions are omitted. SQL evaluates availability and selects
the first failing reason. List, query and generic mutation responses omit the map.
The SDK era marker is `baseline: 'workbase-sdk'`; domain fields and relations named
`actions` and `access` are reserved in that era, including declarations without compiled access.
Legacy configurations retain their existing response and naming contracts.

`POST /api/:entity/:id/actions/:name` accepts `{}` for input-less commands.
Object-shaped command schemas declare other accepted body keys; body `id`,
`rowId` and `role` are rejected. Values/defaults/transforms run once through the
command schema, with the path supplying `id`. Role permission runs before record access; the first rule of
one atomic batch rechecks read/write predicates and conditions with `expectRows: 1`.
A hidden/unknown/masked action returns GET's `404 not_found` body. A readable,
unavailable action returns `409 {error: 'action_unavailable', reason}`. Diagnosis
is read-only after rollback. `client.act(entity, id, name, signal)` caches a returned
detail row or refetches detail; failures expose `ApiFailure.reason`.

Account links opt in with `defineAccess({ accountLinks: { worker: {
invitationRole: 'staff' } }, ... })`. The role must exist, differ from the owner,
and have read access to the linked entity. Legacy instances retain `member`.
The mapping registers `invite`, `cancel_invite`, `link_account` and
`unlink_account`; their core SQL conditions are recorded as `opaque: true` in
lock version 1. These adapter commands are reachable through the record
dispatcher. The existing legacy `link_account`/`remove_access` commands keep their
original `rowId`/`userId` inputs and behavior.

For mapped links, detail includes `access` only with `invitations.read`:
`{state, account, invitation}`, with states `no_account`, `invited`, `expired`,
`linked`. Account is `{id, display_name, email}`; invitation is
`{id, email, expires_at}`. Linked state has no invitation. Staff read scope and
mutation grants remain authored instance policy; the fixture grants self-read.

The invite body is strictly `{email}`, link is `{user_id}`, cancel and unlink
are `{}`. Body selectors and roles are rejected; the route owns the record id. Invitation
credentials/selectors in a card body receive the same `404 not_found` regardless
of their existence; they can never select another invitation.
Invite returns `{invitation_id, expires_at, accept_url}` with `Cache-Control:
no-store`; the credential is absent from detail, audit and locks. It queues one
outbox intent in the same D1 batch. Expired history is superseded by migration
004's trigger before its partial unique index is checked. Delivery is separate.
Unlink clears links and pending account invitations, retaining membership and
independently granted access. `client.actWith(entity, id, name, body, signal)`
returns `{record, result}` after the same cache refresh as `act()`; credentials
stay in the result and are never cached as record data.
