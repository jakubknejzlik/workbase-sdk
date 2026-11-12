# Findings for ADR #260

The V3 architecture works end-to-end for the five worker routes, including a statically imported Leaflet custom page. This is a feasibility proof, not a replacement console or a production SDK API. Implementation references below are relative to the repository root; proof commands run from the root.

## Decisions that required an implementation choice

1. **Default exports versus TanStack's `Route` exports.** `packages/ui-v3/src/vite.ts:48` mirrors `ui/` into `.ui-v3/routes/` and invokes the real TanStack generator. It consumes `ui/` as the authoring route source; TanStack physically scans the generated mirror. The generated `createFileRoute` wrappers and tree are gitignored and outside `ui/`. This is necessary because TanStack expects `Route` exports and updates its source files. **Proposal:** adopt this adapter boundary, retain one authoritative route discovery function, and pin generator/runtime versions together before production (the spike reuses the repo's existing 1.146.2 generator / 1.170.41 runtime pair). No mandatory lazy loading. Dev changes regenerate and reload; incremental tree updates are not investigated.

2. **Safe extraction needs export-preserving component stubs.** `packages/ui-v3/src/vite.ts:8` resolves imports before stubbing, so extensionless `.tsx` imports work. It transpiles the component and lexes its named/default exports; it never evaluates the component or its imports. This is lexical export discovery, not AST-based page/manifest extraction. A fresh SSR loader imports the route data and calls `getManifest()`. The normal client build receives the actual Leaflet code. **Proposal:** keep this dedicated extraction environment, support named/default exports explicitly, and reject/diagnose `export *` barrels or non-component values exported from component directories. The spike does not resolve star re-exports. Data-module top-level side effects still execute; this is not a sandbox for untrusted code. A real import of Leaflet in Node fails with `window is not defined`, whereas extraction succeeds.

3. **A `.ts` file's location cannot supply TypeScript generic context.** `packages/ui-v3/src/index.ts:51` binds `Schema`, entity and slot-registry types once; `examples/spike-cleaning-worker/ui/-model.ts:5` exports bound helpers. That keeps `'name'` typed through `row`, `section`, `columns`, tabs, lists, omit/search/orderBy and slot props; `'nmae'` fails the real tsc CLI. Type-only registry import prevents layouts from transitively importing React. **Proposal:** generate or expose an instance-bound helper facade (`defineUI(schema, 'workers', registryTypes)`) rather than claiming that a file path alone infers an entity. This is a small explicit deviation from the examples' unbound global helpers. The page helpers accept the common layout value and defer entity/layout mismatches to runtime validation; the complete entity type is not preserved in the branded Page. Production should carry that phantom entity parameter through Page/Layout.

4. **`uses` is authoritative metadata, not inferred from components.** `packages/ui-v3/src/index.ts:125` validates all declared `uses` and unions layout fields, slot field dependencies, related columns and list order/search into the manifest. Deleting a custom page's `worker.name` dependency fails the real CI entry point. `examples/spike-cleaning-worker/schema.ts:5` explicitly maps Cleaning's plural entity `workers` to the decision's singular namespace `worker`; `slots` maps to `slot`. **Proposal:** standardize that schema namespace mapping and reuse this dependency walker for MCP field impact checks. Only direct fields are supported here. Five-hop to-one paths from the later #255 decision are outside this slice. Metadata cannot prove that arbitrary component code declared every field it accesses. Permission/row-policy validation needs capabilities and the API and is not claimed by this mock.

5. **Registry metadata must stay importable without rendering code.** `packages/ui-v3/src/index.ts:101` validates slot props and constructs an object containing only declared field values. `examples/spike-cleaning-worker/ui/-slots.ts:7` declares the `userLink` field parameter and context requirements (`record`, `row`, `form`). Render components live below a minus directory and are stubbed during extraction. **Proposal:** keep registry metadata in `.ts`, render code in components, and perform actor-field projection before passing declared fields to slots. Slot record keys are typed to the schema's userLink fields. Real authorization, command execution, `p.fields`, filter slots and `p.action` are not implemented. The explicit action node exists but rejects commands because this worker fixture has no command registry.

6. **Import restrictions need an independent source check.** `packages/ui-v3/src/check.ts:19` inspects TypeScript import/export syntax only for CI. It follows local data dependencies and catches React re-exports; custom page runtime imports are restricted to the SDK plus components. This is separate from manifest extraction. The spike deliberately rejects third-party runtime dependencies in data modules because it cannot audit their transitive graph. **Proposal:** specify a production allowlist for pure data helpers, and preserve the separate source/semantic validation stages. `customPage` component code is opaque. Filename/parameter-normalized collisions are rejected; the spike tests directory-style routes, not all TanStack naming conventions.

7. **Layout source identity must survive importing.** `examples/spike-cleaning-worker/ui/workers/-form.layout.ts:5` attaches explicit `source` metadata; new/edit point to that same layout source, while custom pages have `layout: null` and `editable: false`. This supports the #262 get/set direction but does not implement MCP mutations, hashing or transactions. **Proposal:** make layout source identity part of the helper/facade contract, then validate it against generated dependency metadata before MCP writes. No AST inference of imported layout origin is claimed.

8. **Older approved examples conflict with later decisions.** The spike follows v5 bare fields and responsive columns, plus #264 `.ts` default exports and component-only TSX. It follows the later declared-fields-only slot rule, not the earlier whole-record rule. See `examples/spike-cleaning-worker/ui/workers/-detail.layout.ts:1` and `ui/workers/$id/trasa.ts:1`. The v5 `omit: ['user']` is retained even though declaring it in the access slot already counts it as placed. **Proposal:** refresh the reference examples to the latest #264/#255 wording. The extra Notes tab contains no additional entity fields and exists solely to prove interactive tabs.

9. **i18n and renderer breadth are intentionally minimal.** `examples/spike-cleaning-worker/src/i18n.ts:1` uses i18next namespaces and disables fallback; `config.ts:1` declares English. Field labels derive from domain keys, layout/page titles are keys. **Proposal:** add dictionary completeness/orphan/plural checks and i18next resource augmentation when expanding beyond the slice. These checks and a general query/params API are not proven here. The renderer and mock adapter live in the fixture; the SDK package proves helpers, validation, extraction and Vite integration. The access component is an honest placeholder, not working invitations. No changes to the live Cleaning instance or existing SDK console.

## Proof

Recorded command output, timings and CI results follow below. Timing is a single-slice feasibility observation, not a guarantee for larger instances or an MCP service SLA. `extractionMs` measures Vite server creation, imports and validation; CLI wall time additionally includes Node/tsx/module startup and server shutdown.

### P1 / P6 — production build and real browser rendering

```text
$ bun run spike:build
rendering chunks...
computing gzip size...
dist/index.html                   0.36 kB │ gzip:   0.27 kB
dist/assets/index-D-GSwtsG.css   19.54 kB │ gzip:   7.71 kB
dist/assets/index-DcY8u4nr.js   478.92 kB │ gzip: 150.00 kB
✓ built in 892ms
```

```text
$ bun run spike:browser
$ bun run --cwd examples/spike-cleaning-worker browser
$ node --import tsx scripts/browser.ts
P1 render PASS /workers (list)
P1 render PASS /workers/w1 (detail)
P1 render PASS /workers/new (create)
P1 render PASS /workers/w1/edit (edit)
P1 render PASS /workers/w1/trasa (trasa)
P6 PASS desktop columns + interactive tabs + access slot; mobile columns stack; screenshots saved
P1 PASS in-memory edit and create save/redirect
```

Chromium 145.0.7632.6, desktop 1440×1000 and mobile 390×844, zero `pageerror` events. [Desktop screenshot](./artifacts/detail-desktop.png), [mobile screenshot](./artifacts/detail-mobile.png). Playwright checks desktop column positions, mobile stacking, both tabs, two real Leaflet vector layers, and create/edit save-and-redirect.

### P2 / P5 — Node-only manifest extraction

```text
$ /usr/bin/time -p bun run spike:manifest
$ bun run --cwd examples/spike-cleaning-worker manifest
$ node --import tsx scripts/manifest.ts
real 1.05
user 1.16
sys 0.09
```

`getManifest()` returned 5 routes in **71.33 ms** (entire CLI **1.05 s**). Actual [manifest snapshot](./artifacts/manifest.snapshot.json) includes paths, titles, uses and layouts:

| Path | Title key | Uses | Layout source |
|---|---|---|---|
| `/workers/$id/edit` | `workers.edit.title` | `worker.name`, `worker.user` | `ui/workers/-form.layout.ts` |
| `/workers/$id` | `workers.detail.title` | `slot.booked`, `slot.job_id`, `slot.starts_at`, `worker.name`, `worker.user` | `ui/workers/-detail.layout.ts` |
| `/workers/$id/trasa` | `workers.trasa.title` | `slot.starts_at`, `worker.name` | `null (custom, non-editable)` |
| `/workers` | `workers.list.title` | `worker.name`, `worker.user` | `ui/workers/-list.ts` |
| `/workers/new` | `workers.new.title` | `worker.name`, `worker.user` | `ui/workers/-form.layout.ts` |

Stubbed modules: `ui/workers/-components/TrasaView.tsx`, `ui/-components/Access.tsx`. The P2 test also proves `typeof window === 'undefined'` and that an unstubbed Node import of the actual `leaflet@1.9.4` fails:

```text
ReferenceError: window is not defined
    at leaflet/dist/leaflet-src.js:230:19
```

### P3 / P4 — rejection tests through real tsc / CI subprocesses

```text
$ bun run spike:test
.proof-Hz5vlK/negative.ts(1,59): error TS2322: Type '"nmae"' is not assignable to type 'Node<FieldName<{ readonly workers: { readonly singular: "worker"; readonly fields: { readonly name: { readonly type: "string"; }; readonly user: { readonly type: "ref"; readonly userLink: true; }; }; readonly relations: { ...; }; }; readonly slots: { ...; }; }, "workers">>'.
 ✓ test/proof.test.ts > P2/P5: Node extraction returns all five routes, layouts and dependencies without Leaflet execution 360ms
Error: ui/workers/$id/trasa.ts: Unknown uses field worker.name
 ✓ test/proof.test.ts > P3: nmae in nested layout fails the real TypeScript CLI 356ms
Error: workers/bad.tsx: .tsx must be inside a -prefixed directory
 ✓ test/proof.test.ts > P3: removed field in custom uses fails the CI command 1105ms
Error: workers/index.ts: data page must not import React (ui/workers/index.ts)
 ✓ test/proof.test.ts > P4: TSX route outside a minus directory fails the CI command 720ms
Error: workers/index.ts: data page must not import React (ui/workers/-list.ts)
 ✓ test/proof.test.ts > P4: React import in a data page fails the CI command 734ms
Error: workers/$id/trasa.ts: customPage may import components only: ../../../schema
 ✓ test/proof.test.ts > CI: React re-export through a data layout fails 722ms
Error: ui/workers/index.ts: Unknown slot unknownSlot
 ✓ test/proof.test.ts > CI: customPage data import fails 701ms
 ✓ test/proof.test.ts > CI: unknown slot id fails 805ms
 ✓ test/proof.test.ts > CI: parameter-name and index route collisions fail 1ms
 ✓ test/proof.test.ts > CI: slots receive declared fields and validated props only 0ms
 ✓ test/proof.test.ts > CI: runtime rejects forged page objects and layout typos 0ms
 Test Files  1 passed (1)
      Tests  11 passed (11)
```

The complete captured test output is [proof-tests.txt](./artifacts/proof-tests.txt). These are expected-failure assertions inside a passing 11-test suite. They include transitive React re-exports, custom-page import boundaries, unknown slots, both collision cases, slot field projection, brand rejection and runtime layout typo checks.

### CI and baseline comparison

Final checks use Bun 1.4.3 (`/opt/homebrew/bin/bun`) and Node 25.8.0. The shell initially selected Bun 1.3.14; the final install and checks explicitly use the declared version. The regenerated lockfile was normalized to the original formatting; every original resolved package/workspace entry is unchanged. Only new dependencies/workspaces were added. A frozen-lockfile install also succeeds.

```text
$ bun install
bun install v1.4.3 (c6da4a4d3)
Resolving dependencies
Resolved, downloaded and extracted [3]

Checked 672 installs across 878 packages (no changes) [15.00ms]

$ bun run lint
$ bun scripts/sdk-lint.ts && bun run spike:check
SDK source whitespace lint passed
$ bun run --cwd examples/spike-cleaning-worker check
$ node --import tsx scripts/check.ts
V3 CI passed: 5 routes; schema/uses/layouts/slots/import boundaries/collisions validated (191.3 ms)

$ bun run typecheck
$ tsc --noEmit && tsc --noEmit -p packages/ui && tsc --noEmit -p packages/frontend-console && bun run spike:typecheck
$ bun run --cwd examples/spike-cleaning-worker typecheck
$ node --import tsx scripts/generate.ts && tsc --noEmit
V3 TanStack wrappers/tree generated outside ui/
```

`bun run test` cannot be reported green locally: its tooling stage requires `WORKBASE_PRIVATE_TERMS`, a CI secret unavailable in this checkout. The initial full run passed 1,856 core/plugin runtime tests and 85 infrastructure tests, then failed with the missing-secret error. The command was repeated once with the declared Bun version after final integration; no further retry is planned for this known environment condition.

The exact same failure was reproduced with a separate, unchanged worktree of `origin/main` / `691c3cdd609af80fc5ccd05723bf67dd7165c7d2` using its own frozen install:

```sh
git worktree add --detach /tmp/workbase-sdk-v3-main-proof 691c3cd
cd /tmp/workbase-sdk-v3-main-proof
bun install --frozen-lockfile
bun run test
bun run check:ci-invariants
```

Main output (excerpts):

```text
 Test Files  109 passed (109)
      Tests  1856 passed (1856)
 Test Files  7 passed (7)
      Tests  85 passed (85)
 Test Files  5 failed | 2 passed (7)
      Tests  3 failed | 96 passed (99)
error: script "test" exited with code 1
error: private terms not provided / incomplete; set WORKBASE_PRIVATE_TERMS
```

The optional `bun run check:ci-invariants` produces that same missing-secret failure on both main and the spike. This is an environment prerequisite, not a newly introduced failing assertion. No workflow or gate was bypassed. The unchanged main worktree had an empty `git status --short`. The complete [main test output](./artifacts/main-test.txt) is included.

The command chain stops at tooling failure, so later suites were run explicitly:

```text
$ bun test scripts/sdk-provenance.test.ts scripts/lib/sdk-workspaces.test.ts
$ bun run --cwd packages/ui test
$ bun run --cwd packages/frontend-console test
$ bun run spike:test
 3 pass
 0 fail
Ran 3 tests across 2 files. [271.00ms]
 Test Files  14 passed (14)
      Tests  97 passed (97)
 Test Files  1 passed (1)
      Tests  13 passed (13)
 Test Files  1 passed (1)
      Tests  11 passed (11)
```

No merge, tag, release or issue-close operation was performed. The existing console source was not edited.

Final Bun 1.4.3 `bun run test` result (exit 1), matching the main failing suite/assertion names exactly:

```text
 Test Files  109 passed (109)
      Tests  1856 passed (1856)
 Test Files  7 passed (7)
      Tests  85 passed (85)
 Test Files  5 failed | 2 passed (7)
      Tests  3 failed | 96 passed (99)
error: script "test" exited with code 1
```

Full [spike CI test output](./artifacts/ci-test.txt) and [later suite output](./artifacts/ci-tail.txt) are attached. Install, lint and typecheck exit 0; the standalone spike suite exits 0. The missing-secret invariants command exits 1 on both trees. No third full test attempt was made for the same known environment condition.
