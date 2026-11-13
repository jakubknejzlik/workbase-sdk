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
  revision: 1,
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
entry; `loadConfig` accepts only canonical `defineConfig` modules. Access locks and check:access are the following slice; no lock/planner, migration
changes or UI are introduced here.

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
altering `config.revision` or physical schema SQL. The lock-based schema revision
planner remains a later slice. Slice-1 declarations without access remain readable
by schema tools; the kernel refuses to execute them with legacy defaults.
