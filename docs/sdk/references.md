# Build-time references and removal checks

`@workbasehq/core/references` provides a pure inventory over captured inputs.
`referenceInventory(input)` returns sorted references, contract dependencies,
diagnostics and explicitly uncovered sources. Each reference records its kind,
resolved entity/field target, entity context, definition file and half-open UTF-16
span (plus one-based line/column endpoints), owner, and use sites. Shared sources
retain every consumer; they are never deleted or rewritten by this service.

The canonical loader returns the exact `sourceTexts` it interpreted alongside
its existing source map. `referenceSource` derives token spans from that capture.
Access observations come from `compileAccess`, including nested relation FK hops,
quantifiers, explicit masks, actor operands, availability conditions, and named
predicate definitions with the full chain of use sites. Predicate expansion,
validation and limits remain in the existing compiler. Expression dependencies
come from `expressionInfo`; literal operands are not identifier references.

Console V3 uses its existing checked source graph and normalization. The adapter
traces literal/helper/import origins for layouts, list columns, omissions,
navigation, data and parameter bindings, custom-page `uses`, and required typed
slot field props. Slot references retain both registry and consumer provenance.
Dictionary entries are inventoried in every configured language, including every
authored plural variant. Domain entity, field and enum keys bind to schema targets;
shared UI keys retain their consuming page/slot contexts. Translated values are
not scanned. Existing dictionary validation still checks required plural forms
and supported Console catalog languages.

Plugins may declare literal domain dependencies independently of contracts:

```ts
const plugin: WorkbasePlugin = {
  name: 'example', version: '1',
  requires: { identity: '^1' },
  schemaReferences: [{ entity: 'worker', field: 'name' }],
}
```

`requires` and `optionalRequires` retain their versioned **contract** meaning and
existing composition validation. They appear in `inventory.contracts`, never as
entity references. `schemaReferences` produces `plugin` references. The adapter
reads registered plugin metadata without running runtime modules or plugin hooks.

`validateRemoval(inventory, intent)` accepts internal `remove_field` and
`remove_entity` intents and returns every known blocker in one deterministic
result, with definition/use-site locations and a repair hint. It also includes
all unresolved coverage diagnostics. References owned entirely by a removed
entity's structural declaration disappear with that declaration; authorization,
external presentation, dictionaries, code and plugins remain blockers. There is
no cascade, source editor, persistence operation, physical plan or DDL here.

`validateInstanceReferences(root, intent?)` from
`@workbasehq/plugins/console/ui/check` captures sources and invokes the core.
The generated Instance `check` script runs `check:references` first, before a
schema/access failure could short-circuit reference diagnostics. It and MCP `validate`
consume these same structured diagnostics. UI findings retain the complete
object as `finding.reference`; MCP returns that object in `errors`. Canonical
reference validation runs before MCP imports trusted runtime modules so source
errors do not bypass the shared check. No removal MCP operation is exposed.

## Coverage limits

Arbitrary executable code cannot be proven safe by matching identifier strings.
Every source in `server/` and `src/` is listed as uncovered executable coverage;
removal remains blocked pending explicit repair/review and a scoped target
Instance typecheck. This slice does not run that target typecheck or pretend to
provide a complete arbitrary-code reference scanner. Custom plugins without
literal metadata and unresolved/computed metadata also block removal.

Computed UI values whose exact origin cannot be traced produce an actionable
`reference-provenance` diagnostic. Unused named predicates have no entity
context; they remain valid declarations but add `unbound-predicate` to uncovered
coverage rather than guessed field targets. Removal is blocked while that gap remains.
Source/compiler failures report an incomplete inventory and cannot yield a safe
removal result. Dictionary validity and structural UI checks remain with their
canonical checkers. This is a build-time read-only analysis service; it does not
establish physical removal readiness or implement rename lineage.
