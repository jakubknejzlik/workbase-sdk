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
`init --id cleaning --target cloudflare-github --display-name Cleaning`. Bootstrap remains create-only;
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
- `set_system_access` takes `role` and `grants`, replacing that role's system
  grants with action names mapped to `"allow"` or `"deny"`.
- `set_entity_access` takes `entity`, `role` and `access`. Access is `"deny"` or
  a complete read/create/update/delete object. Each operation accepts `"allow"`,
  `"deny"`, or `{ "where": { ... }, "fields": [ ... ] }` with optional `fields`.
  Domain access lives in `schema/<entity>.ts`; system entity access in `access.ts`.
- `set_account_link` takes `entity` and `invitationRole` and updates `access.ts`.
- `set_instance_display_name` takes `displayName`: trimmed, nonblank text of at most
  1000 characters. Case, Unicode, quotes and backslashes are preserved as data.
  Call `propose_change` with `{ "instance": "cleaning", "baseRevision": 1,
  "changes": [{ "kind": "set_instance_display_name", "displayName": "Cleaning" }] }`.
  `inspect_schema` exposes the saved `displayName` while retaining the selector.
  Name and locale changes can share a presentation-only batch; combining them
  with domain, runtime or access changes is rejected. Continue through validation,
  preview, disposable verification and promotion as below.
- `set_locale` takes `locale`, `defaultLanguage` and/or `languages` (`en`/`cs`).
  V3 presentation changes require a separate proposal and preserve the domain revision
  and schema lock. See the language example below.

The access compiler checks roles, actions and entity matrices. Composition and
access kinds can share a proposal; `propose_change` also accepts these V3 kinds.
Mixing them with legacy kinds is rejected with `mixed_change_kinds`.

For enabled console languages, call `propose_change` (or `propose_composition`)
with a separate proposal, for example:

```json
{
  "instance": "my-instance",
  "baseRevision": 1,
  "changes": [{ "kind": "set_locale", "languages": ["en", "cs"] }]
}
```

`languages` replaces the ordered, nonempty, unique list of enabled languages
(`en`/`cs`); the first entry is the V3 default. `locale` and `defaultLanguage`
remain optional independent settings; `defaultLanguage` updates
`ui.defaultLanguage`. Language proposals edit literal values in `config.ts`,
retaining its imports, schema-lock binding and other options. Provide the
consumer's `locales/<language>/ui.json` and `domain.json` dictionaries separately.
Recreate older locale proposals as new proposals to use this V3 publication path.

Continue through these tools in order:

1. `validate` with `{proposalId}` checks the target kernel, access declarations,
   committed history and deployment requirements. Resolve blocking requirements
   through reviewed source or infrastructure changes before proceeding.
2. `preview_migration` with `{proposalId}` returns exact proposed file bytes,
   regenerated access locks, plugin migration statuses and plugin SQL. Domain
   `sql` is empty. Review the file and access-lock changes before verification.
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
Presentation proposals also write `config.ts`. The domain revision, schema lock and
domain migrations stay unchanged. Review and commit promoted files through the
approved PR process.
Promotion returns `appliesToDatabase: false`; plugin migrations run through the
normal SDK migration engine at deploy. Promotion does not install dependencies,
configure infrastructure, send mail or apply a live database migration.

V3 domain-change promotion is unsupported and returns `v3_promote_unsupported`.
Physical schema changes require reviewed source edits and migration generation.
Custom plugins/commands, plugin removal and role definitions also require reviewed
source changes. Runtime authoring accepts only the canonical built-in composition
shape; noncanonical sources fail closed with `runtime_not_canonical`.
