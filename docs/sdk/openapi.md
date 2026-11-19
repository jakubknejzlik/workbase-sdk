# Committed OpenAPI

The build-time generator produces an OpenAPI 3.1 JSON document from the loaded
schema, composed command/workflow registries and the existing source config hash.
The CLI is exported as `@workbasehq/core/openapi/cli`:

```ts
import { runOpenApiCli } from '@workbasehq/core/openapi/cli'
process.exitCode = await runOpenApiCli(process.argv.slice(2))
```

Use `--write` to regenerate. Without it, missing or different bytes fail the check
without writing anything. `--config`, `--root` and `--directory` follow the access
CLI conventions. By default `openapi.json` sits beside the Instance's `config.ts`.
The SDK root's `openapi:write` and `check:openapi` scripts target `worker-access`.

Bind the committed artifact in the Instance's `config.ts` after binding its schema
lock: `bindOpenApi(bindSchemaLock(defineConfig({...}), lock), spec)`, with
`bindOpenApi` imported from `@workbasehq/core/schema` and `spec` from
`./openapi.json`. `createApp` serves its canonical bytes anonymously at
`GET /openapi.json`. The route helper is exported from
`@workbasehq/core/openapi/routes`. Unbound or invalid runtime data returns
503 `{ "error": "openapi_not_bound" }`; invalid bindings throw during binding.

Provisioning hashes the file beside `config.ts` into `OPENAPI_SHA256` and exposes
it as `build.json.openapi`. Consumers without the artifact report `unbuilt`.
Run `check:openapi --live <origin>` after building to compare the served bytes,
`build.json.openapi` and the committed file. This also checks local generation
drift, never writes, and exits non-zero on missing metadata or any mismatch,
including a bundle built with an older spec. `--live` and `--write` are exclusive.

The CLI uses the existing literal `loadConfig` boundary and composes a kernel
from that loaded config. The pure `generate(config, kernel, configHash)` function
also accepts an already composed registry, including registered Instance commands
and workflows. Loading executable Instance registration modules is subject to the
existing loader's restrictions. Generated-artifact wrappers are recognized without
reading the spec into the source hash; the hash algorithm is unchanged.
The literal worker fixture mirrors the programmatic runtime fixture's schema and
access policy, with a test requiring identical generated documents.

Objects use the access lock's canonical serializer. Set-like declaration arrays
are sorted without locale-dependent comparison; authored enum order is retained.
The query extension reuses the current public schema projection verbatim. Request
schemas use a default-free Zod input projection with an explicit public vocabulary
allowlist. It follows output-facing metadata across wrappers and pipelines, carries
sensitivity internally, and omits pipeline-only constraints and object keys absent
from the public output shape. Shared schemas are converted once per generation;
runtime default, prefault and catch factories are never evaluated. The existing `/schema` projection and its output-mode behavior
stay unchanged.

REST list cursors contain the last returned row id. Query cursors are opaque
signed tokens bound to the query and authorization scope. Optional response fields
allow field masks and query selections; strict row objects reject undeclared keys.
The document publishes field names and safe metadata, including masked fields,
while omitting row filters, predicate names, expression bodies, defaults, credentials
and deployment configuration. Entity permissions reuse `/schema.policies` exactly:
entity → role → `true`, without operation grants or internal tables. Field metadata
uses the same public field projection as `/schema`; protected user-link/computed
flags and action condition inventories or command associations are omitted.
Action components encode both tuple lengths, and every component insertion rejects
an existing name.

Generic command results have no registered output schema and remain opaque.
Built-in access action results describe credential property names as strings;
no token or URL value is included. JSON Schema cannot express every runtime
semantic check (authorization, cursor verification, query cost and uniqueness).

The document reserves its own public path. Swagger UI, YAML, client generation
and per-role documents are outside this contract.

`POST /query` supports SDK-owned limit/offset paging. Send `offset: 0` for the
first page and `(page - 1) * limit` for later pages. `limit` remains required
(1–100); `offset` must be an integer from 0 through `QUERY_LIMITS.maxOffset`
(default 10,000, inclusive). This SDK-wide cap bounds skipped root rows per
request. Larger offsets return HTTP 400 `query_invalid` at path `["offset"]`
before any rows or totals SQL. Use cursor paging for deeper traversal; cursor
paging is unaffected by this cap. Offset responses include
`data`, `offset`, `limit` and `next_cursor: null`. Add `includeTotal: true` to
receive `total`, an exact `COUNT(id)` over the complete authorized, filtered
list source before sorting or paging. It includes organization/actor policies,
search, `labelWhere`, confirmed user `where` filters, query `rowAccess`, and the
selected configured view predicate/access state. Empty and out-of-range
pages still report the complete matching total. No instance-authored count
query or configuration is needed. Count statements use the normal query budgets
and are not executed for unreadable scopes.

Cursor migration: existing callers may continue to omit `offset` and follow
`next_cursor` unchanged. They may also request `includeTotal`; the total covers
all matching rows, independent of cursor position. Do not combine `cursor` and
`offset`. New numbered-page callers use offset paging. Ordering includes an ID
tiebreaker; concurrent writes can still move offset page boundaries. Rows and
total use the same source but separate statements, so concurrent writes between
those statements can also change the total.

Send `view: "<id>"` to select a view from the resolved list configuration (plugin
list contributions take precedence over model UI hints). Omission and `"all"`
mean no view predicate; the configured default is a UI preference. The view's
`where` and `rowAccess` are ANDed with the confirmed user conditions, including
manual query `rowAccess`. Conflicting access states therefore match no rows.
`list.rowAccess` configures the access control's presentation; its selected state
is sent as query `rowAccess`, using the existing invitation-read authorization.

Add `includeViewTotals: true` to receive `viewTotals`, a map of exact counts for
each readable view. A missing `all` view is synthesized when views are configured.
Each count replaces only the selected view and keeps org/actor policies, search,
`labelWhere`, user `where`, and manual access conditions. It uses the same wrapped
`COUNT(id)` source as the main total; pagination and sorting do not affect it.
Views removed by console projection are omitted entirely, including their IDs;
they do not receive a zero count. Selecting an unknown or unreadable view fails
before SQL. A scope denied all rows executes no counts and returns an empty map.

View counts are opt-in independently of `includeTotal`. Every count is charged
against existing request/statement budgets; expensive combinations can be
rejected before SQL. No instance-authored count configuration is accepted. Keep
view/count flags unchanged when following a signed cursor. UI wiring for tab
counts, numbered pages, and draft-versus-confirmed filters belongs to #232.
