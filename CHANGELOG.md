# Changelog

## Unreleased

- Add policy-only `actorLinkedIn` for protected user links: organization-scoped live account/issuer authority, an indexed EXISTS without target read-policy recursion, and atomic write pre/post-image enforcement. MCP config validation and serialization preserve the predicate. (#172 G1)

## 0.2.12 — 2026-11-09

- MCP verifies registry SDK package identities and integrity through portable primitives and installs upgrade targets in isolation with a packaged verification bridge. (#218, #220)
- Public `upgrade_sdk` proposals support target-bound validation, migration preview and disposable verification with durable evidence; promotion writes the exact verified artifacts and SDK metadata transition while preserving the Instance revision and application bytes. (#222, #224)
- SDK-upgrade submission through `submit_change` and the automatic PR-to-Production flow remain unfinished; this release does not complete the end-to-end SDK upgrade workflow.

## 0.2.11 — 2026-11-08

- Prepare the first public SDK release from `jakubknejzlik/workbase-sdk`: GitHub Actions OIDC Trusted Publishing with npm provenance for core, plugins and mcp.

## 0.2.10 — 2026-11-07

- Existing Instances upgrade to Model B through a core plugin-ledger migration (`workbase-core/001_model_b`): role CHECK constraints are removed from memberships/invitations/access_tokens with a column- and index-preserving rebuild, roles are validated in code, account-entity `users` rows are backfilled from Better Auth, and the migration fails closed (`migration_blocked`) on ambiguous data or incoming foreign-key actions. (#177)
- `add_user_link` links an account to a record through a protected account link field with per-entity uniqueness; the caller's role is pinned between prepare and plan (a role change in between returns 403 with no writes). (#174)
- Test harness retries local D1 `SQLITE_BUSY` contention. (#151)

## 0.2.9 — 2026-11-07

- Membership roles are managed through MCP (`add_role`, `remove_role`, `set_permissions`, `set_organization_permissions`) and every role grant — invitation create/resend/accept, member role change, machine token issue — goes through one core subset check (`canGrantRole`): the actor must hold every entity operation and organization action of the target role, unknown roles fail closed, and live SQL guards recheck the issuer's membership inside the same D1 batch. The configured owner role and the built-in `member` role (no default grants) are always present and cannot be removed; `member` is not offered as an invitable/default role in the console until #177. (#175)

## 0.2.8 — 2026-11-06

- Allow adding an optional (nullable) reference to an existing entity: the planner rebuilds the affected table atomically in one D1 batch, keeps existing records and NULL links, recreates supplemental indexes and uses the fresh-schema shape for the organization-scoped composite FK and scoped ref index. Required references stay blocked with an explicit manual-backfill reason; tables whose physical shape drifted from the generated schema (generated columns, WITHOUT ROWID, partial/unnamed unique indexes, triggers, unclassifiable DDL) are refused instead of rebuilt. (#173)

## 0.2.7 — 2026-11-05

- Show an empty reference (NULL foreign key) as `—` instead of the "unavailable record" placeholder across lists, detail, joined columns, dashboard and pickers; deleted or forbidden targets still render as unavailable and stay indistinguishable. Absence and availability propagate separately through chained computed references.

## 0.2.6 — 2026-11-05

- Add MCP `set_label` and `set_locale` config operations, composable with display-expression changes in one proposal; generated display captions resolve the new labels.
- Document both operations in the bootstrapped instance `CLAUDE.md`.

## 0.2.5 — 2026-11-05

- Format date/datetime operands in composed display labels with the console's shared field formatter, locale and timezone across lists, reference cells and create/edit pickers. Preserve raw SQL values for search, sorting and cursors.
- Caption expression display columns with the localized singular entity label instead of the generated field name.

## 0.2.4 — 2026-11-04

- Add read-only computed fields (including scoped refs) and serialized ts-query expressions as record display labels. SQL filtering, sorting, paging and picker search evaluate scoped values; masked dependencies return NULL.
- Validate raw-free expression nodes, schema references, result types, dependency cycles and display path limits. Every subquery and ref uses current organization and row policies.
- Add MCP computed-field authoring operations and expression display changes with metadata-only migration previews and history.
- Respect the instance locale in the console, use entity labels in create actions, and keep mobile list Actions beside the primary column without clipped neighbours.
- See [computed field authoring and MCP operations](docs/computed-fields.md).

## 0.2.3 — 2026-11-04

Patch release of all three SDK packages; repairs the 0.2.2 upgrade path.

- Config MCP starts with legacy missing/invalid `displayField` declarations.
  `inspect_schema` includes validation diagnostics; `validate({instance})` returns
  every display-field error and its suggested MCP change without editing config.
- New `set_display_field` change updates an existing entity's title metadata.
  Batch all suggested repairs, validate and preview, verify on disposable D1, then
  promote. Data, tables and historical SQL are preserved; promotion records a new
  config version and metadata-only revision migration. Refs and unreadable fields
  remain invalid titles. Runtime validation remains strict.
- Planning accepts an older validated physical baseline and upgrades its SDK
  metadata in the normal revision migration. Invalid archived configurations stay
  visible in history with rollback blocked until repaired.
- Release gate and packed-template smoke repair the real sanitized 0.2.1 revision-3
  fixture through MCP, including data/history preservation and no destructive SQL.
  See [the upgrade instructions](docs/sdk/getting-started.md#upgrade-existing-configs-to-023).

## 0.2.2 — 2026-11-04

Patch release of all three SDK packages.

- **Breaking for schemas without a record title:** every entity that is listed in the
  console or targeted by a `ref`/relation must declare a readable `displayField`.
  Validation fails with a suggested field instead of the old build-time warning.
  The hidden per-project display hints map is gone; the project schema is the only source.
- Console: a column headed "ID" always shows the real (shortened) record id, never a label.
  The record-name column is headed by the `displayField` label. Fallback label is the
  shortened id instead of "Unnamed Record".
- MCP planning sets `displayField` when proposing entities; `verify:deploy` rejects
  served schemas with unresolved display fields.

## 0.2.1 — 2026-11-04

Patch release of all three SDK packages.

- Core: `provision()` now works in a consumer's real `sst diff`/`sst deploy`.
  Provision config is evaluated outside SST's ts-node loader (plugins no longer use
  directory imports), and Pulumi is loaded from SST's platform runtime instead of the
  consumer's copy, fixing `b.Va is not a function` during resource registration.
- CI: new packed-SDK `sst diff` smoke (`scripts/sdk-sst-smoke.ts`) in `check`.

## 0.2.0 — 2026-11-04

All three SDK packages (`@workbasehq/core`, `@workbasehq/plugins`,
`@workbasehq/mcp`) release together at `0.2.0`.

- Core: packaged migration/schema helpers at `@workbasehq/core/infra`, the
  `workbase-migrate` CLI, and explicit-input SST `provision()` at
  `@workbasehq/core/infra/provision`. Deployment tooling stays optional for runtime
  and migration-only consumers.
- Console: generic browser models load from the runtime console model contract,
  registry and live capabilities, including unfamiliar instance IDs and new entities.
  Prebuilt generic assets ship inside plugins; resolve them with
  `consoleAssetsDir()` from `@workbasehq/plugins/console/assets`.
- MCP: the empty standalone registry template uses packaged migrations, provisioning
  and console assets. `workbase init` reads MCP package metadata and pins all three
  SDK dependencies to `0.2.0`; no producer checkout or private console archive is needed.

**Breaking changes**

- The console model contract replaces the producer's compiled instance-model
  catalog. Private domain workflows and UI customizations are excluded from the
  generic console; consumers supply domain extensions separately.
- Fresh MCP projects start with empty entities, permissions and policies and use
  thin SST entrypoints with explicit deployment/auth/email inputs. Existing
  tarball/override templates need migration to the registry layout.
- Plugins requires core `0.2.0` exactly. Core runtime/schema metadata reports
  `0.2.0`; review schema compatibility and migration history when upgrading an
  existing instance. Never regenerate committed migrations.

## 0.1.0 — 2026-11-02

Initial public release of the Workbase SDK under the `@workbasehq` npm scope,
licensed under Apache-2.0, with exactly three packages:

- `@workbasehq/core` — configuration, authorization, migrations and runtime primitives.
- `@workbasehq/plugins` — ten plugins as subpath exports: `/audit`, `/console`,
  `/identity`, `/idp-auth`, `/local-auth`, `/machine-credentials`, `/mail-outbox`,
  `/members`, `/organizations`, `/permissions`. There is no root export.
- `@workbasehq/mcp` — configuration MCP, data MCP and the standalone template.
  `workbase-mcp [config]` and `workbase-mcp data` run separate server processes.

The console stays private and is distributed only as a built tarball.
The SDK follows a `0.x` API commitment: breaking changes are allowed and recorded
here from the first release. See [ADR 0007, point 7](docs/adr/0007-open-sdk-closed-product.md#decision).
