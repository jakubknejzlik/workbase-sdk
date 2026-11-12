# Findings for ADR #260 — round 2

Round 2 replaces the instance renderer with a schema-driven SDK renderer, adds a second entity, and addresses review F1–F5 on the same draft PR. Local gate evidence is recorded below; the PR check is the authority for the secret-enabled public scan.

## Decisions and review fixes

1. **SDK rendering boundary.** `packages/ui-v3/src/react.tsx` renders every entity helper and direct `page()` result using the same layout walker. Schema metadata selects labels, display fields, field types, reference options, enum labels and relation targets. `packages/ui-v3/src/store.ts` owns a generic memory store. Instance `src/main.tsx` only wires schema, seed data, slots, navigation, generated pages and i18next into the SDK provider. Instance `runtime.tsx` and per-entity mock functions were deleted. There are no entity names or per-entity branches in the SDK.

2. **Second entity and form.** `schema.ts` projects jobs with original string title, reference client_id, enum priority and read-only enum status (default draft). Three editable field types use independent form state. Both helpers and direct `page()` (`ui/overview.ts`) render those layout values. Create/edit submit to the memory store, preserve read-only values, and redirect using the generated page catalog. The browser checks saved field values and the updated list. This is an in-memory API proof; refresh resets it.

3. **Relations are data.** `related` reads the schema's target, foreign-key field and cardinality. Worker details select by worker_id and job details select by job_id from the same slot records. Both render through the same table component. Tests and browser assertions use two records per entity so unfiltered or fixed relation rows cannot satisfy them.

4. **F1 — public content.** The fixture now has a neutral directory/package name and neutral sample content. Previous tracked screenshots and logs were removed; new screenshots/logs live outside the repository. The guard, policy, release workflows and existing SDK package behavior are unchanged. A complete local public scan still requires the private vocabulary supplied in CI; missing-secret failures are not proof that the public scan passes. The authoritative remote CI result is linked from the PR and recorded in the final task report.

5. **F2 — dev queue recovery.** The regeneration queue catches a prior rejection before scheduling the next generation; server shutdown drains outstanding work before temporary sources can be removed. A real Vite watcher test introduces an invalid field, observes the validation error, fixes it, adds a route, observes the generated route, removes it and observes removal. Schema/config changes are also watched. Regeneration still rebuilds the mirror and reloads the app; no incremental-generation performance claim.

6. **F3 — route grammar.** Discovery, manifest paths and generated wrappers accept only directory-style routes and named dollar parameters. Dots, pathless/layout prefixes, groups, escapes, reserved route tokens and nonterminal index segments are rejected. Tests compare all ten accepted manifest paths with real TanStack output, retain index/parameter collision checks and reject unsupported filenames. This deliberately narrows the spike grammar instead of claiming support for all TanStack conventions.

7. **F4 — import boundary.** Runtime data dependencies must resolve to auditable local `.ts` files; declaration-only files and other runtime extensions fail explicitly. Tests cover `.js`, `.mjs`, `.cjs`, `.jsx`, `.mts` and `.cts` React re-exports. Type-only dependencies are erased and remain allowed. CI syntax inspection is separate from import-based manifest extraction. Custom component code remains opaque to that source boundary check.

8. **F5 — entity identity.** `Layout` carries a schema type parameter and literal entity; Page preserves both. `NoInfer` prevents a mismatched layout from widening the entity accepted by a page helper or `page()`. Real tsc assertions reject a worker layout on the slots entity and check the returned page's literal entity. The runtime also rejects layout/page entity disagreement. `defineUI` is the explicit SDK binding API; local facades export its layout constructs. Routes continue to call SDK page helpers directly, so an eventual MCP implementation can recognize the page call. MCP must treat a facade as an explicit schema/entity binding, rather than arbitrary editable helper code; facade editing and MCP transactions are not claimed here.

9. **Responsive spans and grid wrapping.** One SDK resolver supplies both validation and CSS variables, inheriting through xs/sm/md/lg/xl. Every breakpoint rejects partial-cell row sums above 12; a full-width span 12 explicitly stacks on a new row. This permits xs 12/12 and md/lg/xl 8/4 without allowing accidental 8/6 overflow. Every breakpoint has a rejection test. Playwright checks actual md/lg/xl column positions and mobile stacking for both entities.

## Entity-specific file inventory

All paths below are relative to this fixture. Schema/layout/route/translation data and the access/map components contain the entity-specific choices; browser/proof files contain entity-specific assertions. SDK files contain none. Bootstrap, i18next and build configuration are infrastructure wiring.

- `schema.ts`
- `ui/-model.ts`
- `ui/-slots.ts`
- `ui/nav.ts`
- `ui/overview.ts`
- `ui/workers/$id/edit.ts`
- `ui/workers/$id/index.ts`
- `ui/workers/$id/trasa.ts`
- `ui/workers/-components/TrasaView.tsx`
- `ui/workers/-detail.layout.ts`
- `ui/workers/-form.layout.ts`
- `ui/workers/-list.ts`
- `ui/workers/index.ts`
- `ui/workers/new.ts`
- `ui/jobs/$id/edit.ts`
- `ui/jobs/$id/index.ts`
- `ui/jobs/-detail.layout.ts`
- `ui/jobs/-form.layout.ts`
- `ui/jobs/-list.ts`
- `ui/jobs/-model.ts`
- `ui/jobs/index.ts`
- `ui/jobs/new.ts`
- `ui/-components/Access.tsx`
- `locales/en/domain.json`
- `locales/en/ui.json`
- `scripts/browser.ts`
- `test/proof.test.ts`

## Remaining scope limits

- Wrappers remain an adapter: authoring routes live in `ui/`, TanStack scans the ignored generated mirror. The existing pinned generator/runtime version pair remains unchanged.
- Extraction imports data and validates SDK brands; it is not a sandbox. Component stubs preserve named/default exports by lexical discovery; star barrels and arbitrary non-component exports remain unproven. Browser execution separately verifies real Leaflet and the instance components.
- `uses` declarations and layout-derived dependencies are validated, but arbitrary custom code dependency completeness is not inferred. Source metadata is explicit; authenticated layout origin, MCP get/set transactions and conflict hashes are not implemented.
- The spike supports direct fields and simple relations, not the broader five-hop field path/query/params API. It has no command registry, actor authorization, p.fields/p.action, filter slots, dictionary completeness or plural validation. Read-only status remains read-only; no transition workflow was invented.
- Access components deliberately show disabled placeholder actions. Production invitations, persistence and backend authorization remain outside the spike.
- SDK strings ship in the sdk i18next namespace; field/enum labels derive from domain keys and page/layout labels remain UI keys. Only English is configured.

## Gate output

```text
$ bun install --frozen-lockfile
bun install v1.4.3 (c6da4a4d3)
Resolving dependencies
Resolved, downloaded and extracted [3]

Checked 672 installs across 878 packages (no changes) [16.00ms]
```

```text
$ bun run lint
$ bun scripts/sdk-lint.ts && bun run spike:check
SDK source whitespace lint passed
$ bun run --cwd examples/spike-directory check
$ node --import tsx scripts/check.ts
V3 CI passed: 10 routes; schema/uses/layouts/slots/import boundaries/collisions validated (92.59 ms)
```

```text
$ bun run typecheck
$ tsc --noEmit && tsc --noEmit -p packages/ui && tsc --noEmit -p packages/frontend-console && bun run spike:typecheck
$ bun run --cwd examples/spike-directory typecheck
$ node --import tsx scripts/generate.ts && tsc --noEmit
V3 TanStack wrappers/tree generated outside ui/
```

```text
$ bun run spike:check
$ bun run --cwd examples/spike-directory check
$ node --import tsx scripts/check.ts
V3 CI passed: 10 routes; schema/uses/layouts/slots/import boundaries/collisions validated (74.49 ms)
```

```text
$ bun run spike:test
 Test Files  1 passed (1)
      Tests  33 passed (33)
```

```text
$ bun run spike:build
✓ 170 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                   0.37 kB │ gzip:   0.27 kB
dist/assets/index-DVoWaWge.css   19.57 kB │ gzip:   7.73 kB
dist/assets/index-B7U_0tbz.js   487.26 kB │ gzip: 152.84 kB
✓ built in 1.19s
```

```text
$ /usr/bin/time -p bun run spike:manifest
"extractionMs": 159.3
real 1.19
user 1.39
sys 0.11
```

Ten paths from the imported manifest: `/jobs/$id/edit`, `/jobs/$id`, `/jobs`, `/jobs/new`, `/overview`, `/workers/$id/edit`, `/workers/$id`, `/workers/$id/trasa`, `/workers`, `/workers/new`. Both component modules were stubbed; the separate raw Leaflet import fails under Node as required. Timing is a single observation, not an MCP SLA.

```text
$ bun run spike:browser
$ bun run --cwd examples/spike-directory browser
$ node --import tsx scripts/browser.ts
P1 render PASS /workers (list)
P1 render PASS /workers/w1 (detail)
P1 render PASS /workers/new (create)
P1 render PASS /workers/w1/edit (edit)
P1 render PASS /workers/w1/trasa (customPage)
P1 render PASS /jobs (list)
P1 render PASS /jobs/j1 (detail)
P1 render PASS /jobs/new (create)
P1 render PASS /jobs/j1/edit (edit)
P1 render PASS /overview (list)
P6 PASS workers: list/detail screenshots; md/lg/xl 8/4 columns; mobile stacks
P6 PASS jobs: list/detail screenshots; md/lg/xl 8/4 columns; mobile stacks
3 PASS schema-driven related tables filter both foreign keys for both records
P1 PASS worker in-memory edit/create and redirect
2 PASS job string/ref/enum create/edit persisted independently; readOnly status preserved; list updated
```

Screenshots outside Git: `../round2-artifacts/workers-list.png`, `workers-detail.png`, `jobs-list.png`, `jobs-detail.png` (also both mobile details). Chromium version and zero page errors are recorded in the external `browser.json`.

The complete local command logs are in `../round2-artifacts/`, outside the public tree. Root tests and the comparison with the archived round-1 main result are recorded below. The unchanged CI workflow performs the full private-vocabulary/public-tree scan; consult the latest PR check before describing CI as green.


```text
$ bun run test
 Test Files  109 passed (109)
      Tests  1856 passed (1856)
 Test Files  7 passed (7)
      Tests  85 passed (85)
 Test Files  5 failed | 2 passed (7)
      Tests  3 failed | 96 passed (99)
error: script "test" exited with code 1
```

Exit 1 is limited to the exact missing-private-vocabulary failures recorded on unchanged main `691c3cd` during round 1. The archived baseline was read from the round-1 commit; this round did not re-run main. A comparison of all failing suite/test names returned `MATCHING_MAIN_FAILURE_NAMES True`.

```text
FAIL  scripts/check-console-public.test.ts [ scripts/check-console-public.test.ts ]
FAIL  scripts/check-sdk-boundary.test.ts [ scripts/check-sdk-boundary.test.ts ]
FAIL  scripts/lib/public-vocabulary.test.ts [ scripts/lib/public-vocabulary.test.ts ]
FAIL  scripts/sdk-bootstrap-workflows.test.ts [ scripts/sdk-bootstrap-workflows.test.ts ]
FAIL  scripts/test/temp-dir-cleanup.test.ts > removes scripts/smoke-console-package.ts state after failed setup
FAIL  scripts/test/temp-dir-cleanup.test.ts > removes scripts/smoke-mcp-template.ts allocation after injected realpath EACCES and process exit
FAIL  scripts/test/temp-dir-cleanup.test.ts > removes scripts/smoke-mcp-template.ts state after failed setup
Error: private terms not provided / incomplete; set WORKBASE_PRIVATE_TERMS
```

The stopped command chain was completed with separate runs of the later suites:

```text
$ bun test scripts/sdk-provenance.test.ts scripts/lib/sdk-workspaces.test.ts
 3 pass
 0 fail
$ bun run --cwd packages/ui test
 Test Files  14 passed (14)
      Tests  97 passed (97)
$ bun run --cwd packages/frontend-console test
 Test Files  1 passed (1)
      Tests  13 passed (13)
```

All requested local gates passed except the explicitly permitted missing-secret baseline. The secret-enabled public scan cannot be established locally; the unchanged remote CI must complete before F1 is described as verified. The preceding PR revision was red (`customer/owner content: bun.lock`); that status is not replaced by any local green claim.
