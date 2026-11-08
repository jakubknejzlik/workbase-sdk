# Runtime console model contract (version 1)

`GET /o/:org/console-model` returns the model needed by a generic browser console
for the running instance. It uses the resolved kernel, including plugin entity,
command and workflow contributions. It has no catalog of known instance IDs and
requires no instance source in the browser build.

The endpoint is a public SDK API, authenticated with the same session/cookie or
Bearer credentials as `/o/:org/capabilities`. The path organization is authoritative
over `X-Organization-Id`. Anonymous requests return 401; a missing membership or
wrong organization returns 403. Successful responses and authentication failures
carry `Cache-Control: private, no-store` and
`Vary: Cookie, Authorization, X-Organization-Id`. Do not persist or share this
actor/organization projection in an HTTP cache.

Browser-safe types are exported by `@workbasehq/core/console-contract`:

```ts
import type { ConsoleModelContract } from '@workbasehq/core/console-contract'

const response = await fetch(`/o/${encodeURIComponent(orgId)}/console-model`)
if (!response.ok) throw new Error(`Console model: ${response.status}`)
const document: ConsoleModelContract = await response.json()
if (document.contractVersion !== 1) throw new Error('Unsupported console contract')
```

The response has four keys:

| Key | Contents |
| --- | --- |
| `contractVersion` | Integer `1`, independent of the instance revision and npm version. |
| `model` | `instance`, `revision`, optional `displayName`, `locale`, `timeZone`, optional `enumLabels` and `ui`, query `limits`, `entities`, executable `commands` and startable `workflows`. |
| `capabilities` | The same live projection as `/o/:org/capabilities`: entity operations/readable/writable masks, command names, workflow actions, resource grants and organization role. |
| `console` | The installed console provider's registry (navigation, pages and entity display overlays), further sanitized through live authorization, or `null` when no provider is installed. Core uses the provider port and imports no plugin implementation. |

Clients must check `contractVersion` before adapting the response. Version 1 may
gain additive optional metadata; changes to existing semantics require a new
contract version. `model.revision` identifies the instance configuration, not
authority changes. Re-fetch on organization changes, role/token changes, denied
operations, focus or the client's capability refresh interval. Discard the old
projection when switching organizations or signing out.

Each entity provides:

- `fields`, including technical base fields and their query `operators`. Fields
  have kernel `type`, explicit `required` and `nullable`, optional enum `values`,
  ref target `entity`, `min`, safe `default`, `readOnly`, `sensitive` and `ui`.
- `writeSchema` and `updateSchema`: authorized JSON Schema 2020-12 projections of
  the create and partial-update CRUD validators, using **input** semantics. These
  include numeric bounds, integer checks, readable non-sensitive enum values,
  datetime format and string/text length limits. Read-only and technical fields
  are absent from their properties. Writable inputs may remain present while
  their unreadable or sensitive literals are omitted, including inside nullable
  branches; server validation still enforces those undisclosed constraints.
- `relations` with target, FK field, cardinality, quantifiers and optional pure-join
  `through` metadata; `checks` for the declared cross-field comparisons.
- `indexes` with name, ordered fields and uniqueness, describing the core planner's
  organization/ID and organization/FK indexes. This is planned model metadata,
  not database introspection or a claim that a deployed migration has been applied.
- `commandsOnly`, `displayField`, expression `labelDependencies`, business
  `columns`, configured `listColumns`, `listLimit`, route templates and the
  configured list/form/detail/section/calendar/lookup hints.

The document contains only authorized metadata. Read fields, enum choices and
labels, columns, checks, indexes, relation/FK targets, display fields and expression
dependencies require live read access to every referenced field/entity. Reference
fields also require a readable target ID; a source mask alone cannot authorize
target literals, predicates or ordering. A check or index with any excluded field
is omitted. Create/update schema properties and
`required` entries require the corresponding operation and writable field grant;
without that operation the schema has no properties. An entity with neither read
nor create/update access is omitted. Write-only entities may have input schemas
while their read metadata is empty. Capability masks remain the same projection as
`/capabilities`; masks alone do not grant operations.

One shared authorization helper governs fields, input-schema literals, presentation
and provider widgets. Disclosed schema and presentation keys are allowlisted;
unknown extensions are omitted. Every presentation copy is sanitized, including
entity hints, `model.ui`, provider overlays and `console.modelUi`. Fields, conditions, calendar operands, related
columns, context lists, detail cards and sort inputs must be readable; forms use
the applicable write grant. Empty field groups and references to excluded cards
are removed. View predicates, detail `when` conditions, `signedBy` values and
search/filter/order dependencies require the same readable, non-sensitive literal
grant as enum choices and input-schema literals. This includes every reference hop,
display field and display-expression operand, even for owners and viewers with
explicit sensitive-field read access. An unsafe detail condition drops its complete
item; unsafe signed formatting drops its complete `signedBy` hint.
A view or widget using a denied predicate is dropped in full, preserving
Boolean meaning. Widget dependencies include selected fields, labels and every
reference hop, display-expression operands, `where`, `labelWhere`, search fields
and ordering (including label ordering). An unreadable target entity, ID, display
field or expression operand drops the complete widget. `ConsoleQuery` exposes
optional `search` and `labelWhere` with the same shapes as the core query API.
Navigation to excluded views, denied entities/pages or other roles is omitted, together with unused configured navigation groups. These rules apply
even when no console provider is installed. The `console` member can therefore be
narrower than the provider's standalone `/console-registry` response.

`fields.required` describes the storage requirement; `fields.nullable` is its
inverse for configured fields. A required field with a server default may be
omitted at creation: use **`writeSchema.required`** to decide which inputs must be
present. `updateSchema` makes all inputs optional and applies no create defaults.
Explicit `null`, `false` and zero retain their normal semantics. The update schema
describes changed business fields; PATCH still requires the existing `If-Match`
header or `version` envelope and at least one changed field. Cross-field checks,
FK visibility, row policies, version conflicts and command rules remain server
checks; a client JSON Schema validator cannot replace them.

Defaults are included only for non-sensitive fields that are readable and writable
for a user with a create/update operation. Other defaults are redacted **after**
schema conversion so omission requirements remain correct. Sensitive defaults are
never returned, even to owners. Command/workflow input schemas retain non-sensitive
defaults, constants, validation bounds and metadata such as `referenceEntity` and
`x-ui`; sensitive defaults/constants/descriptions and example annotations are removed
recursively. Sensitive metadata propagates to nested schema nodes. Property names
such as `default` are retained as property names. Defaults/constants (and enum
literals) on an ancestor containing sensitive descendants are omitted in full,
including object/array values and descendants reached through local `$ref`s.
Shared definitions used in a sensitive context are conservatively redacted in all
uses, including alias descriptions. Local references resolve root fragments,
anchors, same-document URI references and URI-decoded JSON pointers with JSON
Pointer escaping. Missing, malformed, ambiguous, external or unsupported
scoped/dynamic references fail
closed: their literals and descriptions, and those of ancestors/aliases that
depend on them, are omitted. Every possible local target of an ambiguous or
dynamic reference is conservatively redacted too. When a reference has no known
local target, literal/description redaction covers the entire input-schema document:
complete alias propagation cannot be proven. Public defaults/constants/enums and
metadata survive when their graph dependencies are fully resolved and
non-sensitive. Unknown
schema keywords also trigger conservative literal redaction. Patterns follow the
same literal-authorization rule; only known JSON Schema formats are disclosed. Examples are always omitted. Reachability is analyzed once
with cycle-safe graph traversal, including shared definitions; ordinary proven
non-sensitive literal data is preserved.

Model metadata is not a grant. In particular, capability field masks describe
eligible fields and do not grant an operation by themselves. Intersect every
rendered read/write control with current operations, readable/writable masks,
read-only/hidden flags, form allowlists and reference target capabilities. The
server repeats its existing authorization and validation on each operation.
Commands are returned only when their registered non-system definition is allowed
by the current live authorization ports; workflow input schemas are returned only
when `start` is allowed. Additional command permissions remain in the contract.
No policy predicates, actor attributes, migration backfills, plugin configuration,
runtime bindings or executable label expressions enter the document.

## Migration from console-generated

The browser migration is W29. This change leaves `/schema`, bootstrap, generated
models, frontend code and existing endpoint enforcement unchanged.

| Generated model field | Runtime contract field |
| --- | --- |
| `instance`, `revision`, `limits` | `model.instance`, `model.revision`, `model.limits` |
| `entities[e].fields` (query + entity fields) | `model.entities[e].fields`, including operators and base fields |
| `entities[e].columns`, `listColumns`, `listLimit` | Same names under `model.entities[e]` |
| `entities[e].relations`, including `through` | `model.entities[e].relations` |
| `entities[e].writeSchema` | `model.entities[e].writeSchema`; accurate input requiredness, safe defaults; new `updateSchema` for edits |
| `entities[e].displayField`, `labelDependencies` | Same names under `model.entities[e]`, from explicit runtime configuration |
| `entities[e].views/form/sections/detail/lookup/list` | Same names under `model.entities[e]`; provider overrides remain in `console.entities[e]` |
| `entities[e].routes` | Same list/detail route templates under `model.entities[e]` |
| `commands` | `model.commands`, filtered by live capabilities; full safe input schemas and configured labels |
| Separate live capability/registry requests | `capabilities` (same live projection), `console` (further sanitized read/write/presentation metadata) |
| Source-only CRUD defaults/bounds/checks | `fields`, `writeSchema`, `updateSchema`, `checks`; new planner `indexes` |
| Config localization | `model.locale/timeZone/enumLabels/ui`, command `ui.label/labelKey`, configured UI label strings |

Gaps intentionally retained: private `hints.ts` display-field/form-order fallbacks,
compiled entity/field translations and specialized domain UI are not public runtime
configuration and are not copied. An unset display field remains unset; W29 must
retain the generic unnamed-record behavior. The config has no general localized
entity/field label dictionary or arbitrary index/uniqueness declarations. No index
declared only in plugin/custom SQL or uniqueness enforced only by a domain command
is inferred. Arbitrary Zod refinements and command execution logic cannot be
represented completely by JSON Schema and remain server validation. The registry
can name extension renderers; availability of specialized browser renderers is
outside this contract. These limits require no instance-source imports for generic
CRUD, schema-defined commands or configured views.

Proof is in `packages/core/test/console-model.test.ts`: neutral fixtures only,
real scoped authentication, real CRUD/constraint behavior, live membership changes,
version/cache/auth checks, registry transport and command/workflow filtering.
