# Query summary contract v1

This is the preparatory contract for SDK #154, slice 1 of 3. The canonical
schemas and types are exported from `@workbasehq/core/query/schema`.
**Summary execution is not activated:** `POST /query`, served OpenAPI and the
registered MCP query tool remain row-only. A contract-valid summary currently
receives the existing safe `query_invalid` envelope through both HTTP and MCP.
Do not send these examples to production expecting execution.

## Request syntax

```json
{
  "entity": "sales",
  "where": { "amount": { "gte": 0 } },
  "summary": {
    "version": 1,
    "metrics": [
      { "op": "count", "alias": "rows" },
      { "op": "sum", "field": "amount", "alias": "total" }
    ],
    "groupBy": ["category"],
    "window": {
      "field": "sold_at",
      "from": "2026-01-01T00:00:00+01:00",
      "to": "2026-02-01T00:00:00+01:00",
      "timeZone": "UTC",
      "bucket": "day"
    },
    "maxGroups": 100
  }
}
```

`entity`, `summary.version` and a nonempty `metrics` array are required. All
other keys shown are optional. `where` reuses the model-derived `filterSchema`
grammar, including relation predicates; it adds no expression or raw SQL input.
Every object is strict. Row keys (`select`, `include`, `cursor`, `limit`,
`orderBy`, labels, search and row-context options) cannot accompany a summary.

`count` counts matching rows, including rows whose other fields are null. It has
no field operand. `sum` accepts a stored `int` or `float` field and ignores null
values. A sum with no non-null values is null. Each metric needs a unique alias
of 1–64 characters matching `^[a-z][a-z0-9_]*$`; `prototype` and `constructor`
are reserved (`__proto__` already fails the pattern). The alias names the metric
in the result, without modifying a field or selecting an expression.

`groupBy` is a nonempty array of distinct stored scalar field names: `string`,
`text`, `int`, `float`, `bool`, `datetime` or `enum`. Numeric sums, grouping and
windows reject computed fields, references, relation paths and expression
operands with specific schema diagnostics. The built-in stored fields `id`,
`organization_id`, `version`, `created_at` and `updated_at` use the same metadata
as row queries. A `day` bucket cannot also appear as a raw grouping field.

## Time semantics

`window.field` must be a stored datetime field. Both endpoints must be valid
ISO datetimes with `Z` or an explicit numeric offset, seconds and at most three
fractional digits. Relative windows and local timestamps without offsets are
rejected. Endpoints are compared as normalized instants, so differently spelled
offsets for the same instant cannot create a nonempty window.

The window is half-open `[from,to)`, with `from < to`. Null window values do not
match. UTC is the only timezone; omitting `timeZone` means UTC regardless of the
instance timezone. Omitting `bucket` only filters the input. `bucket: "day"`
adds a grouping dimension named after `window.field`, containing the UTC
midnight at the start of that day. The two explicit `groupBy` dimensions are
additional to this optional time dimension.

Buckets intersect the window. First and last buckets may be partial; their
metrics include only matching instants inside the window. A partial first
bucket's midnight may precede `from`. Empty buckets are omitted, never filled
with zeros. Daily bucket admission counts all intersecting UTC days, including
partial days; it is distinct from elapsed duration. A 366-day window starting
at noon intersects 367 days and is invalid when daily bucketing is requested.

## Result semantics

```json
{
  "kind": "summary",
  "version": 1,
  "data": [
    {
      "groups": { "category": null, "sold_at": "2026-01-01T00:00:00Z" },
      "metrics": { "rows": 3, "total": 125 }
    }
  ]
}
```

`kind` and `version` distinguish this result from an entity-row page. Each row
contains separate, exact `groups` and `metrics` maps. Group keys are the requested
field names (plus the bucket field); metric keys are exactly the requested
aliases. Aliases may equal a group field name because these maps are separate.
There is no cursor or pagination contract. A request-specific result schema is
built with `summaryResultSchema(config, entity, summary)`.

Null grouping values form a single group per otherwise equal tuple. Scalar
types are preserved, including booleans and enum values. Datetime group values
are normalized UTC ISO strings. Bucket keys are non-null UTC midnights. The
executor must emit one row per distinct group tuple in deterministic ascending
order: declared `groupBy` fields first, then the bucket. Null sorts first;
numbers sort numerically, booleans false before true, strings/enums by binary
UTF-8 order, and datetimes chronologically. Caller ordering is unavailable.

Without grouping or bucketing, the result always has one row with `groups: {}`.
Empty input yields count 0 and sum null. With grouping or bucketing, empty input
yields `data: []`. No synthetic null group or empty day row is emitted.

Counts must be nonnegative safe integers. Integer sums must remain safe
integers; float sums must be finite. Null is valid for sums, never counts.
The later executor must detect overflow before coercion or loss of precision
and reject it; it must not round, clamp, emit infinity or return a partial total.
The result schema checks representable values, not the correctness of an
aggregation, exact arithmetic, group uniqueness or ordering.

## Structural limits

All summary ceilings live in `SUMMARY_LIMITS`; row-query limits are unchanged.

| Dimension | Ceiling |
| --- | ---: |
| Metrics | 8 |
| Explicit grouping fields | 2 |
| Output groups (`maxGroups`, default 100) | 100 |
| Elapsed window duration in 24-hour days | 366 |
| Intersecting daily buckets | 366 |

`maxGroups` must be an integer from 1 to 100. The time and group ceilings apply
independently: a valid daily window can still produce too many output groups.
Execution must reject excess groups instead of truncating them. These structural
caps do not bound input rows, scanned rows, SQL work or combined page cost. Work
admission and measured budget calibration belong to slice 2.

## Types, fragments and SDK compatibility

Use `SummaryQuery<Model, Entity>`, `SummaryOptions<Model, Entity>`,
`SummaryMetric`, `SummaryWindow`, `SummaryField` and
`SummaryResult<Model, Entity, Options>` with literal model declarations retained
with `as const`/`satisfies`. Numeric, datetime and stored-scalar operand names
then follow the model at compile time. A normalized `InstanceConfig` whose
fields have widened to string keys necessarily relies on runtime validation.
Alias syntax, nonempty arrays and numeric caps also require runtime validation.

`summaryQuerySchema(config, entity)` and `summaryResultSchema` are the canonical
runtime schemas. The detached build helper `openapi/summary-contract.ts` projects
their request/result fragments through the existing `publicInputSchema`
conventions. MCP-style fragments use `z.toJSONSchema` on those same schemas.
Fragments own local recursive references; embedding them in OpenAPI components
requires rebasing those references to the component location. Neither helper
registers a live operation or tool.

JSON Schema preserves structural shape, operand enums, alias syntax and array
and numeric bounds. It cannot express the runtime refinements for alias/group
uniqueness, bucket/group-field collision, normalized endpoint ordering, elapsed
duration, intersecting bucket counts or UTC-midnight arithmetic. Consumers must
run canonical runtime validation too. Neither projection proves authorization.

`SUMMARY_VERSION` is 1 and belongs to the pinned SDK release. It is not an
independently negotiated protocol. Unknown versions are rejected. This
pre-release contract adds no legacy syntax, compatibility aliases, fallback
grammar or named custom reports. Existing row types and `validateQuery` behavior
remain unchanged in this slice.

## Authorization and activation boundary

Contract validation is not permission checking. Before execution, the server
must authorize the entity, every metric operand, group key, time field and every
predicate dependency against effective entity/field permissions, credential
operation restrictions and issuer permissions. Computed predicate dependencies
and relation traversal need their existing dependency checks even though metric,
group and window operands are stored-only. Organization isolation and row
policies apply before aggregation. Counts must not bypass row visibility, and
hidden operand denials must not disclose values or private configuration.

Slice 2 implements the scoped compiler/executor, input-row and physical-work
admission, group/cost bounds, exact overflow rejection and safe observability.
Only after those guarantees pass may HTTP, served OpenAPI and registered MCP
discovery activate the shared summary contract together. A bounded-source
sentinel must reject excess work instead of presenting a partial aggregate as
an exact total; an input LIMIT does not itself bound physical scans.

Slice 3 adopts the contract in page widgets. It must enforce the explicit page
grant intersected with all effective dependency permissions (D2) and combined
page-widget budgets, coordinated with SDK #149 / PR #163. This contract slice
does not modify that work. SDK #154 stays open until all three slices and the
authorization/execution obligations are complete.
