# Authoring V3 composition, access, presentation and constraints through MCP

The standalone `.mcp.json` registers `workbase_config` alongside `workbase_data`
and `workbase_ops`. After provisioning dependencies, launch it from the Instance
directory, including an incomplete scaffold. It runs the
installed `workbase config --root .` and needs no API credentials or optional
environment variables. Data and ops keep separate credentials and responsibilities;
only those remote servers need an app origin such as `https://app.example.test`.
Existing Instances must merge the new entry manually: init preserves existing files.

`WORKBASE_MCP_STATE_ROOT` defaults to `/tmp/codex/mcp-state`; relative values resolve
once at startup against the launch cwd, independently of `--root` or `.mcp.json`.

Call `list_docs({})`, then `read_doc({"name":"mcp-composition.md"})` (or another
returned name) for the four guides shipped with the installed package. Responses
include its version and raw-byte SHA256. Names are a closed enum; paths are not
accepted. The first successful load snapshots all four guides, each capped at
32 KiB, for the server lifetime. Restart to load changed packaged docs.

Before choosing a change, call `capabilities({"instance":"my-instance"})`.
It derives change kinds and routes from the schemas and baseline. `eligible` means
kind-level stage support; `reachable` means reachability from a new proposal if
prerequisites succeed. Stage errors and upstream `blockedBy` reasons are separate.
Strict validation, canonical source, revision/history/dependencies, target role
safety and disposable verification still apply. Constraint batches must be separate;
V3 presentation batches cannot mix with runtime/access/domain edits.

`submissionConfigured` is conservative per-instance operator metadata, false by
default even with a global GitHub callback. Embedders may use
`createServer({root, github, submissionConfigured: instance => configuredInstances.has(instance)})`.
This synchronous resolver reads trusted local configuration only: no credential
retrieval, network calls or target details. It does not prove credentials work.
See Operator GitHub target below for stdio provisioning.

For a fresh root, call `bootstrap_instance`, then `initialize_instance` with
`{ "instance": "my-instance", "mode": "preview" }`. Review the five generated
artifacts (schema lock, initial migration, OpenAPI and both access locks), their
exact bytes, hashes, conflicts and `planHash`. Apply with
`{ "instance": "my-instance", "mode": "apply", "planHash": "<preview planHash>" }`.
Then explicitly create the independent local target as described below and continue
with `inspect_schema` in the same stdio session or after restart.
Initialization holds the instance lock and publishes all files through guarded
recovery. A matching completed initialization is unchanged; partial or differing
artifacts return `initialization_conflict` and are preserved. Source or dependency
changes invalidate the plan. `dependencies_missing` identifies the package and
remedy; initialization never installs packages, accesses a registry or deploys an instance.

Bootstrap accepts optional `displayName` (trimmed, nonblank, at most 1000
characters), defaulting to `id`. The CLI forwards it as
`init --id fieldops --target cloudflare-github --display-name "Field Ops"`. Bootstrap remains create-only;
renaming an initialized instance uses the proposal flow below.

Bootstrap also accepts optional `initialComposition` to select the complete role/access
graph **before** any target is provisioned. It reuses `set_roles` and the access
operations below; there is no separate runtime or account-role list. For example:

```json
{
  "id": "fieldops",
  "target": "cloudflare-github",
  "initialComposition": {
    "roles": ["owner", "dispatcher", "viewer", "member"],
    "organizationOwnerRole": "owner",
    "access": [
      { "kind": "set_system_access", "role": "owner", "grants": {
        "organizations.create": "deny", "organizations.update": "allow",
        "members.leave": "allow", "members.read": "allow",
        "members.update": "allow", "members.remove": "allow",
        "invitations.accept": "allow", "invitations.create": "allow", "invitations.read": "allow",
        "invitations.revoke": "allow", "tokens.create": "allow",
        "tokens.read": "allow", "tokens.revoke": "allow",
        "audit.read": "allow", "workflows.read": "allow",
        "workflows.resume": "allow", "workflows.cancel": "allow"
      } },
      { "kind": "set_entity_access", "entity": "worker", "role": "owner",
        "access": { "read": "allow", "create": "allow", "update": "allow", "delete": "allow" } },
      { "kind": "set_entity_access", "entity": "worker", "role": "member",
        "access": { "read": { "where": { "user": { "eq": "$actor.id" } }, "fields": ["name"] },
          "create": "deny", "update": "deny", "delete": "deny" } },
      { "kind": "set_account_link", "entity": "worker", "invitationRole": "member" }
    ]
  }
}
```

Grants are explicit: new identifiers start denied, including the owner; an unchanged
identifier retains its scaffold grants under the shared `set_roles` rules. Add
`set_entity_access` for any SDK entities the owner should access. Each
`set_system_access` replaces the whole system matrix and must explicitly include
every supported action as `allow` or `deny`. The worker invitation mapping must
reference a final non-owner role. The complete graph and built-in runtime are compiled in private staging
before any scaffold file is published. Invalid graphs publish nothing. The generated
`config.ts`, `access.ts`, `schema/worker.ts` and `runtime.ts` share that graph;
the SDK derives the account-role enum from it. Omitting `initialComposition`
preserves every default scaffold byte (`admin,staff`, owner `admin`).

Initial composition is create-only: the destination must be empty apart from
pre-provisioned `node_modules`. Existing source, artifacts or target files cause
conflicts, preserving all existing bytes and leaving missing scaffold files absent.
Select the graph in the first bootstrap call; use proposals for later role changes.
The physical schema lock, initial domain migration bytes and revision remain equal
to the default scaffold. Initialization preview/hash/publication guards include all
four graph sources and generated OpenAPI/access projections; runtime permissions
must agree with config roles and owner. Existing generated artifacts still conflict
if their bytes differ.

Bootstrap and initialization author source. Target creation is a separate explicit
operation. Call `create_local_target` with `{ "instance": "fieldops", "mode": "preview" }`,
then apply with `{ "instance": "fieldops", "mode": "apply", "planHash": "<preview planHash>" }`.
It requires initialized V3 sources and available dependencies, runs the supported
SDK/plugin/domain migration chain for the selected graph, and returns durable
`instanceId`, `targetId` and `creationPlanHash` attestation. No host-side SQLite
setup, manual environment mapping, network or deployment credentials are needed.
The server chooses `.local/mcp-target/` inside the instance root; back up this
directory with the instance. It is independent of disposable verification state
and survives disposable cleanup and server restart. Do not move or substitute its
receipt, root or database: the association binds root and database file identities.
It does not configure Wrangler deployment or a running app's database binding.

Completed creation is idempotent and reports `unchanged`, including when the target
has since gained records. The receipt records creation provenance, never current
emptiness. Normal migrations seed the `instance` organization, so a subsequent
owner replacement is rejected. Select initial roles during bootstrap, rather than
using a later owner-replacement proposal. Other composition proposals continue
through `validate` → `preview_migration` → `apply_to_disposable` → `promote`.
Target creation does not promote source or apply subsequent proposals to that target.

Apply requires the exact preview plan; source or dependency changes return
`stale_plan`. Creation records intent before migration, stages each attempt in a
new exclusive file, and publishes without replacement only after a durable ready
receipt. Retry interrupted creation using its original source/dependency inputs.
Interrupted attempts remain preserved in `.local/mcp-target/`; no retry overwrites
or deletes a database. A substituted/changed pending target returns
`local_target_conflict` and needs operator review. Pending creation cannot attest
role safety. Keep receipts and associated files together; do not use the disposable
as a target or supply paths, SQL or `fresh: true` in tool arguments.

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

For an initial graph, use bootstrap's `initialComposition` above. For a later
role proposal, use
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
A completed `create_local_target` association supplies this evidence automatically.
Existing operator mappings remain supported: `WORKBASE_MCP_ROLE_DATABASES` is a JSON
object mapping the instance selector to the absolute local target SQLite path; an
explicit mapping takes precedence. An invalid explicit mapping never falls back
to the server-managed target. Verification binds target file identity and contents,
and promotion rechecks them; target substitution or changes require verification
again. Missing/inaccessible
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
   committed domain history on fresh local D1. Require `ok: true, verified: true`.
4. `promote` with `{proposalId, expectedRevision: 1}` publishes the verified files
   locally. Replace `1` with the revision inspected for this proposal. Promotion
   is local publication, before GitHub submission or deployment.
5. After successful promotion, call `submit_change` with
   `{"instance":"my-instance","proposalId":"<returned proposalId>","expectedBaseSha":"<40-character SHA>"}`.
   Obtain the current approved base SHA from the operator's review channel.
   Repository, directory and credentials come only from operator configuration;
   tool arguments cannot select them. The proposal must retain its matching
   validation/verification, promoted-file snapshot and unchanged source/dependency
   proofs. Submission opens or returns one PR on `workbase/change-<proposalId>`.
   Inspect `ok: true`, `prUrl`, `headSha`, `checkState` and `previewState`; pending
   checks are not success. A retry returns the same PR rather than opening another.
   Without configuration, submission returns `github_not_configured` after its
   earlier proof gates. Human review/CI, merge and deployment remain separate;
   submission never merges, tags or deploys.

For a V3 presentation/display-name change, the domain revision and history stay
unchanged. If inspection started at revision 1, observable success requires:

- `apply_to_disposable`: `{"ok":true,"verified":true}`.
- `promote`: `{"ok":true,"status":"promoted","revision":1,"appliesToDatabase":false,"files":[...]}`.
- Subsequent `inspect_schema`: the requested new `displayName` and `revision: 1`.

The unchanged revision is expected for this flow. The operator separately reviews
the persisted successful proposal proof and exact source diff. An audit line
recording a tool call alone proves neither success nor exclusive provenance.
An MCP-only consumer can use the outputs/readback above; it does not need filesystem
tools to perform the operator's separate review.

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

A physical V3 `add_field` can pass `propose_change` and be stored as a proposal;
this is not publication support. Legacy V3 domain-change promotion is unsupported
and returns `v3_promote_unsupported`, so that proposal cannot reach promoted or
submittable state. Calling `submit_change` on it returns its own first prerequisite,
`promotion_required`; the upstream blocker remains `v3_promote_unsupported`.
Validation or disposable verification must not be inferred from proposal acceptance.
The constraint-only flow below supports named unique, `ref_equality` and
`ref_immutable` constraints through authored schema files and the bundle/lock planner. Other physical schema changes require
reviewed source edits and migration generation.
Custom plugins/commands and plugin removal require reviewed
source changes. Runtime authoring accepts only the canonical built-in composition
shape; noncanonical sources fail closed with `runtime_not_canonical`.

### V3 entity constraints

Use `propose_change` with a constraint-only `set_constraints` proposal to replace an entity's complete
constraint list. This uses the typed constraint contract (`unique`, `ref_equality`,
`ref_immutable`) and the shared
bundle/lock planner; it preserves the authored module, imports and unrelated
literal properties.

```json
{
  "instance": "example",
  "baseRevision": 1,
  "changes": [{
    "kind": "set_constraints",
    "entity": "assignment",
    "constraints": [{
      "kind": "unique",
      "name": "slot_worker_unique",
      "fields": ["slot", "worker"]
    }]
  }]
}
```

Follow `validate` → `preview_migration` → `apply_to_disposable` → `promote`.
Preview includes exact schema source, migration bundle and lock/artifact bytes.
Promotion publishes those reviewed files and advances the schema revision; it does
not apply to a live database. Validation replays committed data before adding the
constraint and compares the resulting schema with a fresh schema. Existing duplicate
data rejects the migration with a located, bounded diagnostic; no data is cleaned.
Changed source, lock, migration or dependency bytes invalidate saved evidence.

Fields must be distinct stored authored keys, and names must be distinct per entity.
Organization scoping and NULL-distinct behavior are supplied by the SDK. A constraint's
fields cannot change under the same stable name; use a new name. An empty list removes
all constraints. Propose constraint edits separately from runtime, access, presentation
and legacy changes.

Unique constraints also accept a single typed equality predicate, for example:

```json
{ "kind": "unique", "name": "confirmed_slot_unique", "fields": ["slot"],
  "where": { "field": "status", "op": "eq", "value": "confirmed" } }
```

The predicate field must be stored and authored. Its literal must match the field type
(and a declared enum value); `eq` accepts string, finite number or boolean literals,
with safe integers for `int`. NULL literals, arbitrary SQL, extra predicate properties
and other operators are rejected. Rows with NULL or nonmatching predicate values do
not participate; NULL entries in the unique tuple remain distinct. The SDK supplies
identifier quoting, literal escaping and organization scope. Adding, removing or
changing only `where` under the same name produces a reviewed drop/create index
migration. Existing matching duplicates reject validation without data cleanup.
Constrained rebuilds and rename publication still require a manually reviewed
migration. Violations use the existing `409 unique_conflict` API/MCP and console path.

Raw predicates and expressions are not supported. The existing legacy `add_index` operation still creates an ordinary
non-unique index and accepts neither `unique` nor `where`.

#### One-hop reference equality (`ref_equality`)

```json
{ "kind": "ref_equality", "name": "booking_location_client",
  "field": "client", "through": "location", "targetField": "client" }
```

Declares `booking.client == booking.location.client` on the entity that owns `field` and
`through`. All three are identifiers (no paths, SQL or multiple hops); `field` and `through`
are stored authored refs and `targetField` is a stored ref on the `through` target with the
same target entity as `field`. Null equals null; missing and foreign-organization references
never pass. The SDK generates insert/update triggers plus reverse guards on the target.
Adding it over mismatching rows fails validation through a read-only preflight, with no data
cleanup. Violations return `422 ref_equality_mismatch` (`detail.constraintId`) over HTTP and the
data MCP, with a localized console message and retained draft.

#### Referenced-field immutability (`ref_immutable`)

```json
{ "kind": "ref_immutable", "name": "location_client_locked", "field": "client",
  "referencedBy": { "entity": "booking", "field": "location" } }
```

Declared on the referenced entity (`location`): its stored ref `field` cannot change while at
least one same-organization row of `referencedBy.entity` points at the row through the stored
ref `referencedBy.field` (which must target the constrained entity). One hop only; status is
never filtered, so cancelled rows still count. A change is any `IS NOT` difference: NULL to a
value and value to NULL are rejected, same-value and NULL-to-NULL updates are allowed, and
unrelated fields stay editable. Unreferenced rows and rows referenced only from another
organization may change; deleting or reparenting the last reference releases the field.
INSERT OR REPLACE and upsert paths are guarded too. Violations return `409 ref_immutable`
(`detail.constraintId`, for example `location.location_client_locked`) over HTTP and the data MCP,
with a localized console message and retained draft. When `ref_equality` also exists, both
may be declared; the immutability trigger fires first, so the stricter `ref_immutable` error is
reported. Constrained rebuilds and renames still require a manually reviewed migration.

### Feedback while native feedback tools are pending

Use the interim route: consumer → coordinator → anonymized issue packet → SDK
owner reply → coordinator delivers the answer → consumer acknowledgment is recorded.
Include the observed installed version (or explicitly unknown), goal, expected and
actual behavior, bounded synthetic evidence and the concrete question. An agent
report, source inspection, successful tool output and a consumer runtime retest are
separate evidence states. The coordinator returns the reply to an MCP-only consumer;
issue creation or delivery alone is not acknowledgment. SDK-native feedback tools
are tracked separately in [#328](https://github.com/jakubknejzlik/workbase-sdk/issues/328).
Physical-field publication and provenance redesign remain separate work.

### Operator GitHub target

The stdio config server can submit a verified, promoted change as a GitHub PR.
Before starting the server, the operator sets `WORKBASE_GITHUB_TARGET` to an
absolute path to a JSON file with this strict schema (unknown properties are
rejected):

```json
{
  "owner": "example",
  "repository": "example",
  "baseBranch": "integration/preview",
  "directory": "projects/example",
  "credential": {
    "type": "token-file",
    "path": "/private/operator/github-token"
  }
}
```

`directory` defaults to `""` (the repository root). Otherwise it is a
repository-relative prefix: slash-separated components containing only letters,
digits, `_`, `-` and `.`, with no empty, `.` or `..` components. The target applies
only to the instance allowed by this stdio server; unknown instances have no
GitHub target. Repository, branch, prefix and credentials cannot be selected or
overridden by tool arguments.

For a GitHub App, replace `credential` with:

```json
{
  "type": "github-app",
  "appId": "123",
  "installationId": "456",
  "privateKeyPath": "/private/operator/github-app.pem"
}
```

App and installation IDs accept positive integer numbers or decimal strings.
The key must be an RSA private key. The server signs a short-lived RS256 JWT,
requests an installation token from GitHub, and caches it in memory until five
minutes before expiry. Concurrent requests share one token request. The token-file
provider reads the trimmed token on each request, allowing operator rotation.
Grant access only to the intended repository, including the contents and pull
request permissions needed to create the branch, commit and PR.

The target JSON, token file and private key must be regular files at absolute
filesystem paths. Every path component must be free of symlinks; use resolved
paths (for example `/private/tmp/...` rather than `/tmp/...` on macOS). Parent
traversal is rejected. Token and key files must not be readable by group or
others (`chmod 600`); violations refuse startup with
`insecure_github_credential_permissions`. Unsafe paths return
`unsafe_github_path`, unreadable files `github_config_unreadable`, malformed
configuration `invalid_github_config`, and invalid token/key contents
`invalid_github_credential`. Credential reads are checked again when needed.

The agent never receives the credential, private key or App JWT. They are never
written into proposals or audit logs, and provider, transport and remote error
text is suppressed. Tokens echoed in GitHub responses are redacted. Keep the
operator files outside the agent's accessible workspace.

After `validate` → `apply_to_disposable` → `promote`, call `submit_change` with
only `{ "instance": "example", "proposalId": "<proposal UUID>",
"expectedBaseSha": "<current base branch SHA>" }`. It creates
`workbase/change-<proposal UUID>`, a commit of the promoted allowlisted files and
one PR into the operator's base branch. The existing REST adapter exposes no
merge, tag, release or deployment API. Without `WORKBASE_GITHUB_TARGET`, a valid
promoted submission still returns `github_not_configured`; earlier validation
errors retain their existing behavior.
