# Authoring V3 composition, access and presentation through MCP

The standalone `.mcp.json` registers `workbase_config` alongside `workbase_data`
and `workbase_ops`. After provisioning dependencies, launch it from the Instance
directory, including an incomplete scaffold. It runs the
installed `workbase config --root .` and needs no API credentials or optional
environment variables. Data and ops keep separate credentials and responsibilities;
only those remote servers need an app origin such as `https://app.example.test`.
Existing Instances must merge the new entry manually: init preserves existing files.

For a fresh root, call `bootstrap_instance`, then `initialize_instance` with
`{ "instance": "my-instance", "mode": "preview" }`. Review the five generated
artifacts (schema lock, initial migration, OpenAPI and both access locks), their
exact bytes, hashes, conflicts and `planHash`. Apply with
`{ "instance": "my-instance", "mode": "apply", "planHash": "<preview planHash>" }`.
Then continue with `inspect_schema` in the same stdio session or after restart.
Initialization holds the instance lock and publishes all files through guarded
recovery. A matching completed initialization is unchanged; partial or differing
artifacts return `initialization_conflict` and are preserved. Source or dependency
changes invalidate the plan. `dependencies_missing` identifies the package and
remedy; initialization never installs packages, accesses a registry or deploys an instance.

Bootstrap accepts optional `displayName` (trimmed, nonblank, at most 1000
characters), defaulting to `id`. The CLI forwards it as
`init --id fieldops --target cloudflare-github --display-name "Field Ops"`. Bootstrap remains create-only;
renaming an initialized instance uses the proposal flow below.

Normal config calls on an incomplete scaffold return `initialization_required`
with this next step. Bootstrap retains its file-copy and conflict contract.

Call `inspect_schema` with the Instance selector (the config ID with underscores
replaced by hyphens). Use the returned revision in `propose_composition` as
`baseRevision`. This example adds built-in login components to a canonical V3
`runtime.ts` while keeping organization creation on the protected ops path:

```json
{
  "instance": "my-instance",
  "baseRevision": 1,
  "changes": [
    { "kind": "set_plugin", "plugin": "organizations", "options": { "allowCreate": false } },
    { "kind": "set_plugin", "plugin": "local-auth", "options": { "methods": ["magic-link"] } },
    { "kind": "set_plugin", "plugin": "mail-outbox" },
    { "kind": "set_interactive", "interactive": true }
  ]
}
```

Supported kinds, as defined in [schemas.ts](../../packages/mcp/src/schemas.ts):

- `set_plugin` adds a built-in plugin or replaces its options. Supported plugins
  are `identity`, `members`, `organizations`, `local-auth`, `machine-credentials`,
  `mail-outbox`, `audit` and `console`. Enable the console with plugin `console`.
  Omitting options resets the selected plugin to defaults. Permissions-provider
  options derive from the current config and are not directly settable.
- `set_interactive` takes `interactive: boolean`; enabling login requires a provider.
- `set_roles` takes an ordered, nonempty, unique `roles` identifier array and
  `organizationOwnerRole`, which must be in that array. V3 has no implicit roles:
  include `member` explicitly if wanted. Combine it with system/entity grants and
  account-link changes in one proposal. The complete final graph is compiled
  together, regardless of operation order. Retained identifiers keep their grants;
  new identifiers start with explicit denial on every system action and entity.
  Owner authority requires explicit grants; role names never copy authority.
  Only one `set_roles` is allowed per proposal.
- `set_system_access` takes `role` and `grants`, replacing that role's system
  grants with action names mapped to `"allow"` or `"deny"`.
- `set_entity_access` takes `entity`, `role` and `access`. Access is `"deny"` or
  a complete read/create/update/delete object. Each operation accepts `"allow"`,
  `"deny"`, or `{ "where": { ... }, "fields": [ ... ] }` with optional `fields`.
  Domain access lives in `schema/<entity>.ts`; system entity access in `access.ts`.
- `set_account_link` takes `entity` and `invitationRole` and updates `access.ts`.
- `set_instance_display_name` takes `displayName`: trimmed, nonblank text of at most
  1000 characters. Case, Unicode, quotes and backslashes are preserved as data.
  Call `propose_change` with `{ "instance": "fieldops", "baseRevision": 1,
  "changes": [{ "kind": "set_instance_display_name", "displayName": "Field Ops" }] }`.
  `inspect_schema` exposes the saved `displayName` while retaining the selector.
  Name and locale changes can share a presentation-only batch; combining them
  with domain, runtime or access changes is rejected. Continue through validation,
  preview, disposable verification and promotion as below.
- `set_locale` takes `locale`, `defaultLanguage` and/or `languages` (`en`/`cs`).
  V3 presentation changes share a batch with `set_label`, `set_catalog_entries` and `set_instance_display_name`, separate from
  runtime/access/schema changes, and preserve the domain revision and schema lock. See the language example below.
- `set_label` takes `entity`, `language` and explicit `pluralForms` for entity
  captions, plus optional `singular` and `object`. A field caption instead takes
  `entity`, `field`, `language`, `label`. V3 captions write domain catalog keys.

The access compiler checks roles, actions and entity matrices. Composition and
access kinds can share a proposal; `propose_change` also accepts these V3 kinds.
Mixing them with legacy kinds is rejected with `mixed_change_kinds`.

For example, replace a fresh scaffold's roles with
`{ "kind": "set_roles", "roles": ["owner", "dispatcher", "viewer", "member"],
"organizationOwnerRole": "owner" }`, together with explicit owner and restricted
role grants and `set_account_link` for each affected invitation mapping. Unresolved
account invitation mappings or navigation roles return actionable diagnostics;
no strings or stored records are automatically reassigned. Navigation declarations
require an explicit reviewed source edit when their referenced roles change.

At disposable verification and again immediately before promotion, removed roles
(old set minus final set) must be unused in the **target** database's memberships,
invitations and access tokens, including revoked, expired and historical rows.
An owner-role change additionally requires no target organizations or memberships.
The operator supplies `WORKBASE_MCP_ROLE_DATABASES`, a JSON object mapping the
instance selector to the absolute local target SQLite path. Missing/inaccessible
or incomplete evidence fails closed with `role_usage_unverified`; a populated
owner transition returns `owner_change_requires_fresh_target`. Neither the empty
verification disposable nor a caller's freshness assertion establishes target
safety. Populated owner transitions need a separately designed data migration.
Every organization counts, including a generated `instance` placeholder. Configure
roles before organization provisioning; this operation never deletes target rows.

For enabled console languages, call `propose_change` (or `propose_composition`)
with a presentation-only proposal. First inspect `dictionaries` from `inspect_schema`: it
contains enabled languages, existing catalogs, required keys with source references,
and plural categories for each supported language. For a fresh worker scaffold:

```json
{
  "instance": "my-instance",
  "baseRevision": 1,
  "changes": [
    { "kind": "set_locale", "languages": ["en", "cs"] },
    { "kind": "set_label", "entity": "worker", "language": "en",
      "singular": "Worker", "object": "worker", "pluralForms": {
        "one": "{{count}} worker", "other": "{{count}} workers"
    } },
    { "kind": "set_label", "entity": "worker", "language": "cs",
      "singular": "Pracovník", "object": "pracovníka", "pluralForms": {
        "one": "{{count}} pracovník", "few": "{{count}} pracovníci",
        "many": "{{count}} pracovníka", "other": "{{count}} pracovníků"
    } },
    { "kind": "set_label", "entity": "worker", "field": "name", "language": "cs", "label": "Jméno" },
    { "kind": "set_catalog_entries", "language": "cs", "namespace": "domain", "entries": {
      "field.worker.user": "Přístup do aplikace"
    } },
    { "kind": "set_catalog_entries", "language": "cs", "namespace": "ui", "entries": {
      "workers.list.title": "Pracovníci",
      "workers.create.title": "Nový pracovník",
      "workers.detail.title": "Pracovník",
      "workers.edit.title": "Upravit pracovníka",
      "workers.nav.title": "Pracovníci"
    } }
  ]
}
```

`languages` replaces the ordered, nonempty, unique list of enabled languages
(`en`/`cs`); the first entry is the V3 default. `locale` and `defaultLanguage`
remain optional independent settings; `defaultLanguage` updates
`ui.defaultLanguage`. Language proposals edit literal values in `config.ts`,
retaining its imports, schema-lock binding and other options. `set_catalog_entries`
upserts flat, nonempty strings into derived `locales/en|cs/domain|ui.json` paths;
other entries are preserved. Arbitrary paths and SDK overrides are not writable.
Translations must be authored explicitly; English is never copied to Czech.
The complete staged config/schema/UI/catalog graph runs through the console UI
validator. Every enabled language must be complete: Czech requires all four
counted forms (`one`, `few`, `many`, `other`), consistent interpolation, and no
orphan keys. Errors include locations and the missing keys. Dictionary-only
batches preserve config and access/OpenAPI artifacts, including their absence.

V3 `set_label` writes counted `entity.<entity>_<category>` keys and the optional
named keys `entity.<entity>.singular` and `entity.<entity>.object`. Entity captions
require every plural category for the language in `pluralForms`; a legacy `plural`
string is refused with an actionable diagnostic. No forms are inferred.
The required-key inventory exposes named forms as optional until authored in an
enabled language, then validation requires them in every enabled language.
The renderer uses the singular form as the accessible name of entity forms and
the object form in the Create label (for example, “Vytvořit pracovníka”);
without an object form it uses generic `sdk:create`. Page/nav titles stay
independent `ui:` keys. Legacy-instance captions retain their existing behavior.
Previously saved legacy caption proposals cannot publish V3 sources; recreate
them with V3 caption/catalog operations. The V3 legacy-write guard remains.

Proofs persist across restarts and bind config/schema/runtime, UI declarations
and checked modules, catalog bytes/path inventories (including absent catalogs),
and prior presentation publication receipts. Edits, deletions, new inputs, and
competing same-revision publications invalidate proofs. Publication rechecks inputs
under the instance lock and journals owned locale-directory creation along with
catalogs, config/artifacts, and proposal metadata for recoverable rollback.

Continue through these tools in order:

1. `validate` with `{proposalId}` checks the target kernel, access declarations,
   committed history and deployment requirements. Presentation batches also validate
   the full staged UI and dictionaries. Resolve blocking requirements
   through reviewed source or infrastructure changes before proceeding.
2. `preview_migration` with `{proposalId}` returns exact proposed file bytes,
   regenerated access locks, plugin migration statuses and plugin SQL. Domain
   `sql` is empty. Review the file and access-lock changes before verification.
   Role proposals also return `roleDiff`, with ordered before/after roles and owner
   metadata and every removed role-indexed source row as an explicit removal.
3. `apply_to_disposable` with `{proposalId}` verifies SDK/plugin migrations and
   committed domain history on fresh local D1. Require successful verification.
4. `promote` with `{proposalId, expectedRevision: 1}` publishes the verified files
   locally. Replace `1` with the revision inspected for this proposal.

The stored proposal kind is `composition_change`. Any tracked input or dependency
change requires validation and disposable verification again. Use `discard` to
close an unpromoted proposal.

Promotion writes changed `runtime.ts`, access declarations in `access.ts` or
`schema/<entity>.ts`, regenerated `access.lock.json`/`access.lock.md`, and proposal
metadata. Access and presentation edits regenerate `openapi.json` only if it already exists.
Presentation and role proposals also write `config.ts`. Role proposals derive runtime
permissions options and the SDK account-role enum from the final config, preserving
the requested order. `inspect_schema` exposes `displayName` and `organizationOwnerRole` alongside
`roles`. The domain revision, schema lock and
domain migrations stay unchanged. Role authoring verifies the physical schema
against the existing lock and replays committed history; a stale physical lock
returns `schema_lock_mismatch`. Review and commit promoted files through the
approved PR process.
Promotion returns `appliesToDatabase: false`; plugin migrations run through the
normal SDK migration engine at deploy. Promotion does not install dependencies,
configure infrastructure, send mail or apply a live database migration.

V3 domain-change promotion is unsupported and returns `v3_promote_unsupported`.
Physical schema changes require reviewed source edits and migration generation.
Custom plugins/commands and plugin removal require reviewed
source changes. Runtime authoring accepts only the canonical built-in composition
shape; noncanonical sources fail closed with `runtime_not_canonical`.
