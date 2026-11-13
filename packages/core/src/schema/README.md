# Canonical entity declarations

`@workbasehq/core/schema` supplies runtime declarations and core schema types.
`@workbasehq/core/schema/load` is a separate build-time entry: it reads source with
TypeScript's compiler API, checks the literal boundary before importing config,
and returns `{ config, sources }`. Keeping the loader separate prevents Node file
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
form; the entity access compiler is a separate change.

`languages` is a nonempty ordered list of unique language tags; its first item is
the Instance default. The loader validates and retains that order. This entry
adds no translation runtime. Entity, field and enum labels belong in
`locales/<language>/domain.json` dictionaries; inline labels are rejected.

Each entity map entry must explicitly import a default or named `defineEntity`
export from its matching `./schema/<entity>.ts` file. The config default export
is a direct `defineConfig({...})` call. Named SDK imports may use local aliases.
The loader resolves imports with its runtime host, validates that exact file,
and rejects ambiguous extensionless imports. Use explicit `.ts` specifiers.
Only direct SDK/entity imports and the declaration export may execute; side-effect
imports, helper wrappers, extra exports and top-level code are rejected before
evaluation. Config options are literal data, except for imported entity identifiers.
The returned default export must retain the SDK's defineConfig identity brand.
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
entry; `loadConfig` accepts only canonical `defineConfig` modules. No access compiler, lock/planner, migration changes or UI are introduced
by the declaration entry.
