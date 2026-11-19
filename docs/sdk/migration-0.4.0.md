# Migrating to SDK 0.4.0 / List config v2

0.4.0 is a coordinated pre-1.0 minor release of core, plugins and MCP. Install
all three at the same version when publication is available. This document
records behavior implemented on the release branch, not a promise that npm
publication or consumer acceptance has occurred. Start with the
[Workers example](../../packages/core/examples/list-v2-workers.ts) and its
[run commands](../../packages/core/examples/README.md).

## Authoring shorthand and canonical output

**No previously supported column-string or filter-kind shorthand was removed or
deprecated.** `defineInstance` accepts `ListInput`; normalized configuration and
console projections use `ListConfig`. Code that manually constructs or consumes
the old wire shape must migrate. Custom console consumers must handle
`contractVersion: 2`, and should consume projected hints rather than authoring
hints, because the projection removes inaccessible fields, views and controls.
Sources: [list-contract.ts](../../packages/core/src/list-contract.ts),
[config.ts](../../packages/core/src/config.ts) (`InstanceInput`, `InstanceConfig`),
[console-contract.ts](../../packages/core/src/console-contract.ts),
[console-model.ts](../../packages/core/src/console-model.ts).

| Old authoring form | Canonical replacement / example | Actual 0.4.0 behavior |
| --- | --- | --- |
| `columns: ['name']` | `columns: [{ field: 'name' }]` | Compatible input; output is always objects. A wire consumer using each element as a string must read `.field`. Flat `listColumns` remains a derived compatibility field. |
| `filter: { status: 'enum' }` | `filter: { status: { kind: 'enum', placement: 'panel', operators: ['in'] } }` | Compatible input; output is an object. Placement now defaults to the panel; specify `placement: 'toolbar'` for an inline filter. |
| `filter: { name: 'text' }` | `filter: { name: { kind: 'text', placement: 'toolbar', operators: ['contains'] } }` | Compatible input; explicit placement preserves a toolbar control. Model-mismatched kinds are rejected. |
| `filter: { name: false }` | Same | Compatible; disables that filter, never a query permission. |
| `search: ['name', 'code']` | Same | Compatible; only string/text fields (or `id`) may be searched. |
| `sort: { status: { fields: ['status', 'name'] }, code: false }` | Same | Compatible; composite scalar sorts keep their configured order (1–4 distinct fields). `false` disables the key. |
| `defaultSort: { key: 'name', direction: 'asc' }` | Same | Compatible; enum/text default sorts still need an explicit `sort` mapping. Ref keys remain invalid as defaultSort. |
| `relatedColumns: { team_location: { via: 'team_id', field: 'location_id' } }` | Same | Compatible; a declared ref→ref display column. Filtering that synthetic key is now supported as label text (`contains`), not an ID relation selector. |
| `pageSize: 30`, `compact: true`, `mobileCards: true` | Same | Compatible; page size remains one of 10, 20, 30, 50, 100. |
| `views: [{ id: 'active', label: 'Active', where: { status: { eq: 'active' } } }]` | Same, within the new maximum of 8 configured views | Compatible below the cap. Nine or more views, formerly unbounded, are now rejected; split/reduce the configured presets. |

These are all keys in the old list grammar. The complete runtime syntax and
model checks are in [list-config.ts](../../packages/core/src/list-config.ts)
(`listInputSchema`, `normalizeListConfig`); compatibility, rejection and
projection evidence is in [list-config-v2.test.ts](../../packages/core/test/list-config-v2.test.ts)
and [list-config-v2-projection.test.ts](../../packages/core/test/list-config-v2-projection.test.ts).
There is no warning-only deprecation path for invalid shapes.

Before (still accepted authoring):

```ts
const list = { columns: ['name', 'status'], filter: { status: 'enum' as const } }
```

After (explicit v2 presentation; also the shape custom wire consumers read):

```ts
const list = {
  columns: [{ field: 'name', secondary: 'code' }, { field: 'status' }],
  filter: { status: { kind: 'enum' as const, placement: 'toolbar' as const, operators: ['in' as const] } },
}
```

Before (formerly accepted, now rejected):

```ts
const views = Array.from({ length: 9 }, (_, i) => ({ id: `view_${i}`, label: `View ${i}`, where: {} }))
```

After: keep at most eight, for example `views: views.slice(0, 8)`. Duplicate IDs
and multiple defaults remain rejected. The formerly reserved `all` ID is now
allowed only for an unconditional view: `{ id: 'all', label: 'All', where: {} }`.
A conditional `all` remains rejected; rename it to e.g. `active`. `where` may be
omitted only for a row-access-only view. The full query DSL still applies to
configured `where` (including operators not exposed by interactive controls).

New column objects allow one string `secondary`, a plain string `label`,
`defaultVisible`, and built-in `cell` kinds: text, identifier, badge, date,
datetime, number. Arrays of secondary fields, localized label objects, callback
renderers and arbitrary CSS are rejected, with no aliases. Badge tones are
neutral/positive/warning/negative and must name real enum values. These were
not accepted legacy shorthand. New filter objects infer kind and intersect
model operators with controls: text→contains; enum/relation→in;
number→eq/gte/lte; datetime→gte/lt; boolean→eq and optional isNull. A boolean
isNull control must include eq. Invalid/duplicate/empty operator lists are
rejected. Sources: [list-config.ts](../../packages/core/src/list-config.ts).

Row access is opt-in (`rowAccess: { column: true, placement: 'panel' }`). The
members provider, account user link, entity create capability and
`invitations.read` gate its presentation; row invitation/query authority is
checked separately. `signed_in` still means linked account, not a currently
active session. Sources: [console-presentation.ts](../../packages/core/src/console-presentation.ts) and
[console-authorization.ts](../../packages/core/src/console-authorization.ts),
[projection tests](../../packages/core/test/list-config-v2-projection.test.ts).

## Cursor → offset boundary

| Surface | 0.4.0 behavior |
| --- | --- |
| List hints | Still specify page size, sort and filters; there is no `list.cursor` or `list.offset` hint. |
| Generated console root table | Changes to numbered offset pages and exact authorized row/view totals. URL `page` is 1-based; request `offset` is zero-based. |
| Generated embedded relation lists, detail relation reads and pickers | Retain cursor paging; calendar does not use the root numbered-table path. |
| Public `@workbasehq/plugins/console/ui/client` list sessions | Retain signed `/query` cursors, fixed limit 25, `next_cursor`; search/sort changes restart the cursor chain. |
| Core `POST /query` | Adds `offset`, `includeTotal`, `includeViewTotals`, `view`; retains signed cursor requests. Combining cursor and offset is rejected (`query_invalid`, offset path). |
| MCP data `query` | Still has the narrower cursor-only strict tool schema; offset/total/view arguments are rejected there even though core HTTP supports them. |
| MCP `list_records` and REST entity list GET | Retain REST last-row-ID cursors, distinct from signed query cursors. No offset argument was added. Audit/operations tools keep their own existing paging contracts. |

Sources: [useGeneratedList.ts](../../packages/console-generated/src/useGeneratedList.ts),
[read.ts](../../packages/console-generated/src/read.ts),
[public client](../../packages/plugins/console/ui/src/client.ts),
[query input schema](../../packages/core/src/query/input-schema.ts),
[query validation](../../packages/core/src/query/schema.ts),
[MCP schemas](../../packages/mcp/src/data/schemas.ts),
[MCP client](../../packages/mcp/src/data/client.ts),
[REST facade](../../packages/core/src/query/facade.ts).

Before, a cursor HTTP caller advances with the previous `next_cursor`:

```ts
const query = { entity: 'workers', select: ['id', 'name'], limit: 30, cursor: previous.next_cursor }
```

That remains compatible. To opt into numbered paging, replace the cursor:

```ts
const query = { entity: 'workers', select: ['id', 'name'], limit: 30, offset: 30, includeTotal: true }
// Page 2: { data, next_cursor: null, offset: 30, limit: 30, total }
```

Never parse a signed or REST cursor into an offset. Offset responses have
`next_cursor: null`; cursor callers keep their response shape unless they opt
into totals. `total` is the exact authorized match count independent of page;
`viewTotals` counts each readable configured view with the confirmed conditions.
Rows and totals use shared policy/search/filter predicates and request budgets.
Ordering appends ascending `id` as a stable tie-break unless already supplied;
offset pages are not a snapshot and concurrent writes can move boundaries.
Sources: [executor.ts](../../packages/core/src/query/executor.ts),
[compiler.ts](../../packages/core/src/query/compiler.ts) (`queryOrder`),
[list-views.ts](../../packages/core/src/query/list-views.ts),
[query-list-total.test.ts](../../packages/core/test/query-list-total.test.ts).

`QUERY_LIMITS.maxOffset` defaults to **10,000**, inclusive; negative, fractional
or larger offsets fail validation before rows or totals SQL. This is a core
limit, not a list hint; use cursors for deeper traversal. Core root query limits
are integer **1–100**; nested includes cap at **20**. List hints/UI offer
**10/20/30/50/100** (default **30**, clamped to root limit). REST/MCP list_records
use **1–90** (REST default **25**). Sources:
[limits.ts](../../packages/core/src/query/limits.ts),
[input-schema.ts](../../packages/core/src/query/input-schema.ts),
[list-model.ts](../../packages/console-generated/src/list-model.ts),
[facade.ts](../../packages/core/src/query/facade.ts),
[MCP schemas](../../packages/mcp/src/data/schemas.ts).

## Resets, URLs and personal saved views

- Root search, sort, confirmed filter/view or page-size changes reset to page 1.
  Panel edits are drafts: Apply commits once and resets paging; Cancel leaves the
  confirmed query and URL intact. Explicit Undo can restore the earlier page.
- Legacy `?cursor=...` is discarded and the root list restarts with a notice;
  actor-bound history cursors are not converted into numbered pages. Invalid or
  above-cap pages and inaccessible settings are pruned/canonicalized. Valid
  numbered `page` and `pageSize` URLs can be shared under the current authority.
- Personal saved views keep only filters, sort/direction, configured view and
  row access. Search text, cursor, page, page size, columns and calendar state
  are not restored. Existing v1 entries with extra stale cursor state are
  filtered, not interpreted as offsets. Apply revalidates against current
  capabilities/selected IDs and starts on page 1; removed access is dropped.
- Actor/org changes clear the outgoing list state. Embedded cursor paths also
  restart invalid query cursors rather than reusing them for changed authority.

Sources: [useGeneratedList.ts](../../packages/console-generated/src/useGeneratedList.ts),
[list-model.ts](../../packages/console-generated/src/list-model.ts),
[saved-views.ts](../../packages/console-generated/src/saved-views.ts),
[saved-views-storage.ts](../../packages/plugins/console/ui/src/saved-views-storage.ts),
[list v2 tests](../../packages/console-generated/test/list-config-v2.test.ts),
[saved-view tests](../../packages/console-generated/test/saved-views.test.ts),
[acceptance tests](../../packages/frontend-console/e2e/list-v2-acceptance.spec.ts).

## Other included integration migration

The release also includes #203's public-origin change. Before:
`{ domain: 'app.example.test', authBaseUrl: 'https://app.example.test' }` with
`WORKBASE_DOMAIN`. After: `{ publicHostname: 'app.example.test' }` with
`WORKBASE_PUBLIC_HOSTNAME`. Legacy `domain`/`WORKBASE_DOMAIN` inputs fail with
migration diagnostics; there is no alias. Hostnames must be literal valid bare
hostnames and are validated without trimming or case normalization. Alternatively
omit the hostname and provide the exact HTTPS `authBaseUrl` fallback. Review
[getting-started.md](getting-started.md),
[public-origin.ts](../../packages/core/src/infra/public-origin.ts) and
[provision-plan.ts](../../packages/core/src/infra/provision-plan.ts) before any
future consumer upgrade. This preparation does not upgrade or deploy consumers.
