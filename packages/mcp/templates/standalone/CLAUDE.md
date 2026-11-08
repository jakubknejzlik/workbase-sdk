> Instance deployment workflows are omitted. Configure and review deployment automation separately before remote use.

# Workbase instance agent guide

This root is one instance. Bun 1.4.3, Node 22.13+, three matching registry SDK
packages. Follow README.md and the SDK getting-started guide for setup and login.
Config id: `{{INSTANCE_ID}}`; MCP selector: `{{INSTANCE_SELECTOR}}`.
Start with entities: {}, permissions: {}, policies: {}. There is no seeded owner.

Start schema/config changes on a branch, then use the configuration MCP:
inspect → propose → validate → preview → apply_to_disposable → promote.
Never edit config.ts or migrations/ by hand. Hand-edit only application domain code
outside generated schema. Fields use snake_case. Every new entity needs explicit
permissions and policies for the declared roles; omitted policies mean none.

After fresh init check for migrations/0001_*.sql. If absent, run
`bun run migrate:initial` once before proposals. Never regenerate existing SQL.
Then inspect_schema, propose_change at the inspected revision, validate,
preview_migration, apply_to_disposable (require verified=true), and promote at the
expected revision. Promotion writes local config, history and SQL only.

After promotion run `bun run typecheck` and `bun run check:migrations`, review
config/history/SQL together, and commit. Stop the local Worker before
`bun run migrate:local` followed by `bun run migrate:plugins`; restart with
`bun run dev` on 127.0.0.1. Push/open a PR only when the operator authorizes it.
The first promotion canonicalizes config; review history and SQL for meaning.

proposals/log.jsonl records attempts (timestamp, callId, tool). A written rollback
adds the same callId with outcome.written=true, fromRevision, newRevision and
migration. An attempt alone does not prove a write.

SST owns remote resources. The entrypoint calls packaged provision() and resolves
consoleAssetsDir(); migrations run through packaged workbase-migrate before upload.
Wrangler config and local persistence are development-only. Read README.md before
remote deploy/remove: stable secret, exact AUTH_BASE_URL, authorized EMAIL_FROM,
optional matching custom domain, resource/stage prefix and shared sst-state access
are operator inputs. WORKBASE_OWNER_EMAIL is the operator's login address only.
Verify HTTPS magic-link delivery and organization creation, not health alone.

Configuration MCP: `bun run node_modules/@workbasehq/mcp/src/bin.ts config --root .`.
Data MCP: the same binary with `data`, WORKBASE_BASE_URL, WORKBASE_TOKEN and
WORKBASE_ORG_ID. Keep separate processes and never commit credentials.

## Record labels

Every readable entity and every ref/relation target must have a `displayField`
pointing to an existing readable field. `name`/`title` are inferred; for other
names set it explicitly (for example `displayField: 'jmeno'`). Choose the first
required string field by default. MCP `add_entity` sets this default and accepts
an explicit `displayField`; validation refuses unresolved labels. Do not add a
private generator hint. Singular UI labels derive from entity names when no
translation is supplied.

Use `set_label` in `propose_change.changes` for captions without renaming identifiers.
Set `language` to `en` or `cs`; for an entity, supply one or more of `singular`,
`plural`, `object`. For a field, supply `field` and `label` instead. Captions must
be non-blank and at most 1,000 characters. Targets must exist (including fields
added earlier in the proposal); computed and system fields can be labelled.
For example, using existing entity/field identifiers:

```json
{ "kind": "set_label", "entity": "bookings", "field": "title", "language": "cs", "label": "Název rezervace" }
```

Use `set_locale` with `locale` and/or `defaultLanguage`, each `en` or `cs`.
`locale` controls formatting; `defaultLanguage` sets `ui.defaultLanguage` for the
console. An explicit user language preference takes precedence. For example:

```json
{ "kind": "set_locale", "locale": "cs", "defaultLanguage": "cs" }
```

Both kinds follow the normal validation/disposable/promotion workflow and preserve
identifiers, stored records and physical schema.
