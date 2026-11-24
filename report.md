# Saved views icon — author evidence

Candidate: `d5bc2d74d6cc8bd8d87a174da0fc3d84d393aabc`. Base: `integration/preview` at `c31fe5e1914c5daff4cca83427b6caa0aca9d41a`.
Branch: `feat/293-saved-views-icon`. Refs #293.

Uses the existing Button icon size, Lucide Settings2 icon and Popover. The trigger has the existing localized `savedViewsMenu` accessible name and native title tooltip (Saved views / Uložené pohledy). The modified indicator remains visible. Saved-view actions, persistence and the separate Columns menu keep their existing implementation.

Approved reference: [List v2](https://github.com/jakubknejzlik/workbase-sdk/blob/c31fe5e1914c5daff4cca83427b6caa0aca9d41a/docs/ui/patterns/list-v2.md), [UI definition of done](https://github.com/jakubknejzlik/workbase-sdk/blob/c31fe5e1914c5daff4cca83427b6caa0aca9d41a/docs/ui/sdk-ui-definition-of-done.md).

**Independent rendered review is pending a separate run. This report issues no visual PASS/FAIL verdict.**

## Files changed

- `packages/console-generated/src/saved-views-controls.tsx`
- `packages/frontend-console/e2e/list-v2-acceptance.spec.ts`
- `packages/frontend-console/e2e/saved-views-layout.spec.ts`
- `packages/frontend-console/test/list-scope-teardown.test.tsx`
- `packages/frontend-console/test/saved-views-menu.ts`
- `packages/frontend-console/test/saved-views.test.tsx`
- `packages/ui/src/index.ts`

## Reproducible checks

Bun 1.4.3, Node 25.8.0, Chromium 145.0.7632.6. The shared exported BUN_INSTALL_CACHE_DIR was preserved. All task scratch and test outputs are under `/tmp/codex-scratch/codex-wr-github-jakubknejzlik-workbase-sdk-293-s1-impl-wr-84e1f3e4`; archive destination is `/Users/jarvis/.sitebrew-work/evidence/codex-wr-github-jakubknejzlik-workbase-sdk-293-s1-impl-wr-84e1f3e4`.

Environment used by the commands below:

```sh
source /tmp/codex-scratch/codex-wr-github-jakubknejzlik-workbase-sdk-293-s1-impl-wr-84e1f3e4/env.sh
```

`env.sh` sets TMPDIR, WRANGLER_LOG_PATH, LIST_V2_OUTPUT and WB178_OUTPUT under the scratch root, W29_PORT=19593, and WORKBASE_PRIVATE_TERMS_FILE to the existing local private configuration. No private configuration values are included in evidence. WORKBASE_KEEP_TMP was never set.

| Exact command | Result | Log |
| --- | --- | --- |
| `bun install --frozen-lockfile` | 658 packages installed; no dependency/lockfile changes | install.log |
| `bun run typecheck` | PASS, root + UI + frontend projects | typecheck-candidate.log |
| `bun run --cwd packages/console-generated typecheck` | PASS | generated-typecheck.log |
| `bun run lint` | PASS | lint-candidate.log |
| `bun run check:ci-invariants` | PASS | ci-invariants.log |
| `bun run --cwd packages/frontend-console test --maxWorkers=2 --testTimeout=15000` | 31 files; 1160 passed, 1 existing expected failure | frontend-unit-final.log |
| `bun run --cwd packages/console-generated test` | 4 files; 56 passed | generated-unit.log |
| `bun run --cwd packages/ui test --maxWorkers=1` | 16 files; 107 passed | ui-unit-serial.log |
| `bun x --no-install vitest run --config packages/plugins/console/ui/vitest.config.ts packages/plugins/console/ui/test/i18n.test.ts --maxWorkers=1` | 1 file; 9 passed | i18n.log |
| `bun /tmp/codex-scratch/codex-wr-github-jakubknejzlik-workbase-sdk-293-s1-impl-wr-84e1f3e4/check-locales.ts` | EN/CS inventories match after CLDR plural suffix normalization; 639 EN keys, 2 label assertions | locales.log |
| `bun run console:build` | PASS for base and final head, including public/terminology scans | base-build.log; head-build-final.log |
| `bun run test:list-v2-acceptance` | 187 passed | list-v2.log; list-v2/results.json |
| `W29_PORT=19594 bun x --no-install playwright test --config packages/frontend-console/playwright.saved-views-layout.config.ts --output /tmp/codex-scratch/codex-wr-github-jakubknejzlik-workbase-sdk-293-s1-impl-wr-84e1f3e4/saved-views-layout` | 4 passed, EN/CS 1440/390 | saved-views-layout.log |
| `W29_PORT=19594 bun x --no-install playwright test --config packages/frontend-console/playwright.application-access.config.ts` | 4 passed, EN/CS 1440/390 | application-access.log |
| `git diff --check` | PASS | diff-check-candidate.log |
| `git diff c31fe5e1914c5daff4cca83427b6caa0aca9d41a --check` | PASS | diff-check-base.log |

Initial unrestricted unit runs hit five-second timeouts on this shared host. Bounded full reruns above resolved them. An additional scope-reset test still expected text on the old trigger; its assertion was updated to inspect the saved-view menu and the full frontend suite was rerun successfully. Early test-helper type errors were corrected before the final typecheck. The first build attempt lacked the existing private terminology configuration; the successful builds use that configuration.

The full runtime suites used build/source commit `555690ea47aac450cadbcdc782bb4529cfd02d18`. The final commit only updates the scope-reset unit assertions; all production sources and browser test sources are identical, and the final full frontend suite includes those assertions. Final head previews were rebuilt and captured at `d5bc2d74d6cc8bd8d87a174da0fc3d84d393aabc`.

## Whole-page rendered previews

Synthetic local Worker seed, EN, 1440×900, 900×900 and 390×900 viewports, full-page PNGs. Both toolbar and open-menu states are captured for base and final head (12 captures). JSON manifests include build source commits, asset SHA, browser version, viewport, URLs and PNG SHA-256 checksums. Base production sources were restored to the pinned base before the base build.

Exact capture commands, each after its corresponding build:

```sh
bun /tmp/codex-scratch/codex-wr-github-jakubknejzlik-workbase-sdk-293-s1-impl-wr-84e1f3e4/capture.ts base
bun /tmp/codex-scratch/codex-wr-github-jakubknejzlik-workbase-sdk-293-s1-impl-wr-84e1f3e4/capture.ts head
python3 /tmp/codex-scratch/codex-wr-github-jakubknejzlik-workbase-sdk-293-s1-impl-wr-84e1f3e4/package-evidence.py
```

### 1440 px

- [base toolbar](d5bc2d74d6cc8bd8d87a174da0fc3d84d393aabc-base-en-1440-toolbar.png) — `/Users/jarvis/.sitebrew-work/evidence/codex-wr-github-jakubknejzlik-workbase-sdk-293-s1-impl-wr-84e1f3e4/d5bc2d74d6cc8bd8d87a174da0fc3d84d393aabc-base-en-1440-toolbar.png`
- [base menu](d5bc2d74d6cc8bd8d87a174da0fc3d84d393aabc-base-en-1440-menu.png) — `/Users/jarvis/.sitebrew-work/evidence/codex-wr-github-jakubknejzlik-workbase-sdk-293-s1-impl-wr-84e1f3e4/d5bc2d74d6cc8bd8d87a174da0fc3d84d393aabc-base-en-1440-menu.png`
- [head toolbar](d5bc2d74d6cc8bd8d87a174da0fc3d84d393aabc-head-en-1440-toolbar.png) — `/Users/jarvis/.sitebrew-work/evidence/codex-wr-github-jakubknejzlik-workbase-sdk-293-s1-impl-wr-84e1f3e4/d5bc2d74d6cc8bd8d87a174da0fc3d84d393aabc-head-en-1440-toolbar.png`
- [head menu](d5bc2d74d6cc8bd8d87a174da0fc3d84d393aabc-head-en-1440-menu.png) — `/Users/jarvis/.sitebrew-work/evidence/codex-wr-github-jakubknejzlik-workbase-sdk-293-s1-impl-wr-84e1f3e4/d5bc2d74d6cc8bd8d87a174da0fc3d84d393aabc-head-en-1440-menu.png`

### 900 px

- [base toolbar](d5bc2d74d6cc8bd8d87a174da0fc3d84d393aabc-base-en-900-toolbar.png) — `/Users/jarvis/.sitebrew-work/evidence/codex-wr-github-jakubknejzlik-workbase-sdk-293-s1-impl-wr-84e1f3e4/d5bc2d74d6cc8bd8d87a174da0fc3d84d393aabc-base-en-900-toolbar.png`
- [base menu](d5bc2d74d6cc8bd8d87a174da0fc3d84d393aabc-base-en-900-menu.png) — `/Users/jarvis/.sitebrew-work/evidence/codex-wr-github-jakubknejzlik-workbase-sdk-293-s1-impl-wr-84e1f3e4/d5bc2d74d6cc8bd8d87a174da0fc3d84d393aabc-base-en-900-menu.png`
- [head toolbar](d5bc2d74d6cc8bd8d87a174da0fc3d84d393aabc-head-en-900-toolbar.png) — `/Users/jarvis/.sitebrew-work/evidence/codex-wr-github-jakubknejzlik-workbase-sdk-293-s1-impl-wr-84e1f3e4/d5bc2d74d6cc8bd8d87a174da0fc3d84d393aabc-head-en-900-toolbar.png`
- [head menu](d5bc2d74d6cc8bd8d87a174da0fc3d84d393aabc-head-en-900-menu.png) — `/Users/jarvis/.sitebrew-work/evidence/codex-wr-github-jakubknejzlik-workbase-sdk-293-s1-impl-wr-84e1f3e4/d5bc2d74d6cc8bd8d87a174da0fc3d84d393aabc-head-en-900-menu.png`

### 390 px

- [base toolbar](d5bc2d74d6cc8bd8d87a174da0fc3d84d393aabc-base-en-390-toolbar.png) — `/Users/jarvis/.sitebrew-work/evidence/codex-wr-github-jakubknejzlik-workbase-sdk-293-s1-impl-wr-84e1f3e4/d5bc2d74d6cc8bd8d87a174da0fc3d84d393aabc-base-en-390-toolbar.png`
- [base menu](d5bc2d74d6cc8bd8d87a174da0fc3d84d393aabc-base-en-390-menu.png) — `/Users/jarvis/.sitebrew-work/evidence/codex-wr-github-jakubknejzlik-workbase-sdk-293-s1-impl-wr-84e1f3e4/d5bc2d74d6cc8bd8d87a174da0fc3d84d393aabc-base-en-390-menu.png`
- [head toolbar](d5bc2d74d6cc8bd8d87a174da0fc3d84d393aabc-head-en-390-toolbar.png) — `/Users/jarvis/.sitebrew-work/evidence/codex-wr-github-jakubknejzlik-workbase-sdk-293-s1-impl-wr-84e1f3e4/d5bc2d74d6cc8bd8d87a174da0fc3d84d393aabc-head-en-390-toolbar.png`
- [head menu](d5bc2d74d6cc8bd8d87a174da0fc3d84d393aabc-head-en-390-menu.png) — `/Users/jarvis/.sitebrew-work/evidence/codex-wr-github-jakubknejzlik-workbase-sdk-293-s1-impl-wr-84e1f3e4/d5bc2d74d6cc8bd8d87a174da0fc3d84d393aabc-head-en-390-menu.png`

Manifests: [base](base-captures.json), [head](head-captures.json).
