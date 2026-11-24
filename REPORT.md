# Issue 292 implementation evidence

PR: https://github.com/jakubknejzlik/workbase-sdk/pull/296 (draft; independent rendered review pending).

Candidate: `72ecf1562d80ed690f3ed7369f2732ae55f63bdc`
Base: `integration/preview` at `c31fe5e1914c5daff4cca83427b6caa0aca9d41a` (remote checked before implementation).
Branch: `feat/292-column-order`.

The existing Columns popover now reuses ghost icon buttons to move visible optional columns up/down. Primary record and trailing Actions columns remain anchored. Hidden columns are skipped. Native disabled controls mark boundaries; focus stays on the moved column, using its opposite button when the activated button becomes disabled. Reset restores configured visibility, order and density. Order has the same session-local React lifecycle as visibility on this base. No query, sorting, saved-view, storage, dependency, lockfile or workflow changes. The menu has no existing live-region pattern, so none was added.

Files changed:
- `packages/console-generated/src/display-menu.tsx`
- `packages/console-generated/src/screens.tsx`
- `packages/frontend-console/src/locales/en.json`
- `packages/frontend-console/src/locales/cs.json`
- `packages/frontend-console/test/list-display.test.tsx`
- `packages/frontend-console/e2e/list-v2-acceptance.spec.ts`

All temporary and runtime outputs use the scratch directory below. The shared exported BUN_INSTALL_CACHE_DIR was retained as-is. WORKBASE_KEEP_TMP was never set.

```sh
export TMPDIR=/tmp/codex-scratch/codex-wr-github-jakubknejzlik-workbase-sdk-292-s1-impl-wr-c8a777aa
export WORKBASE_PRIVATE_TERMS_FILE=/Users/jarvis/.config/workbase/private-terms.txt
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run --cwd packages/console-generated typecheck
bun run --cwd packages/frontend-console test --maxWorkers=2 --testTimeout=15000
bun run --cwd packages/console-generated test
bun run console:build
LIST_V2_OUTPUT="$TMPDIR/e2e-final" bun run test:list-v2-acceptance
WB178_OUTPUT="$TMPDIR/access-final" WB178_SCREENSHOTS="$TMPDIR/access-screenshots" W29_PORT=19430 bun x --no-install playwright test --config packages/frontend-console/playwright.application-access.config.ts
node "$TMPDIR/locale-parity.mjs"
git diff --check
```

Locale parity: 641 EN / 661 CS keys; all 625 canonical keys match (locale-specific plural categories normalized), all 641 shared interpolation sets match, both new keys present in both locales. Check script and exact assertions are in `locale-parity.mjs`.

Captures use the real built console, local Worker/D1 and existing synthetic fixtures, Chromium 145.0.7632.6. No substituted shell/styles or client data. Both revisions show the Columns menu open. Viewports: 1440×900, 900×900, 390×900; PNGs are full-page captures. Names include the candidate head SHA even for base captures. `base/manifest.json` and `head/manifest.json` record source/build SHA and viewport provenance. Script: `capture.ts`.

```sh
CAPTURE_OUTPUT="$TMPDIR/base" bun "$TMPDIR/capture.ts" base
# Base files then renamed to include candidate SHA; source SHA stays the pinned base in its manifest.
CAPTURE_OUTPUT="$TMPDIR/head" W29_PORT=19431 bun "$TMPDIR/capture.ts" head-72ecf1562d80ed690f3ed7369f2732ae55f63bdc
```

Screenshot paths (relative to evidence archive):
- `base/base-72ecf1562d80ed690f3ed7369f2732ae55f63bdc-en-1440-columns.png`
- `base/base-72ecf1562d80ed690f3ed7369f2732ae55f63bdc-en-900-columns.png`
- `base/base-72ecf1562d80ed690f3ed7369f2732ae55f63bdc-en-390-columns.png`
- `head/head-72ecf1562d80ed690f3ed7369f2732ae55f63bdc-en-1440-columns.png`
- `head/head-72ecf1562d80ed690f3ed7369f2732ae55f63bdc-en-900-columns.png`
- `head/head-72ecf1562d80ed690f3ed7369f2732ae55f63bdc-en-390-columns.png`

The six PNGs and provenance manifests are also published in evidence-only commit `11e05f597b1b7dff386d1ba8646c214f435e29c2`, without adding them to the implementation PR diff.

Initial verification attempts are retained: the unrestricted frontend unit run had five timeout/readiness failures under concurrent load; the complete suite was rerun with two workers. Initial focused browser tests had 3 EN passes and 3 CS failures because the new test reused an English-only footer helper; the test now compares language-independent fixture IDs. A premature browser-suite launch was interrupted before the build completed. The initial access run was interrupted to correct its screenshot-output environment; its generated images were moved into scratch, and the final run explicitly sets WB178_SCREENSHOTS. The first build lacked WORKBASE_PRIVATE_TERMS_FILE; reruns use the existing local private-terms file without printing it. The two-worker run still hit one existing 5-second scope-test timeout (1160 passed, 1 expected fail); the final full run uses a 15-second CLI execution budget. No product assertions or repository timeout settings were changed.

Independent rendered review is a separate run. No visual PASS is claimed here. Approved reference: `docs/ui/patterns/list-v2.md`, `docs/ui/sdk-ui-definition-of-done.md` (reference archive SHA-256 `f95b87d93e814b41f1d8856b1063b9bb1b23237cb9147a2145dd7194e167a2f0`).

Final verified results:
- Frozen install: 658 packages installed; lockfile unchanged.
- Whitespace lint: passed.
- Root/UI/frontend typecheck plus console-generated typecheck: exit 0, zero errors.
- Frontend full unit suite: 31 files passed; 1161 passed, 1 expected fail (1162 total), exit 0. Final command uses two workers and a 15-second execution budget.
- console-generated full unit suite: 4 files, 56 passed, exit 0.
- Application access e2e: 4 passed, exit 0.
- Base and final head console builds: passed; public asset and terminology checks passed (8 public assets, zero private model IDs/customer names).
- Six requested EN screenshots captured and published; head build sourceCommit matches the candidate exactly.
- Locale parity: passed (625 canonical keys / 641 shared interpolation sets / 2 added keys per locale).

- Full list acceptance: 192 passed / 1 timed out / 0 skipped (193 cases), exit 1. All six new column-order tests passed at 1440/900/390 in EN and CS.
- Fresh-runtime targeted rerun of the sole full-suite failure: 1 passed, exit 0; test completed in 4.7 seconds (8.2 seconds including runtime setup). The original 45-second timeout did not reproduce. This is not presented as a clean single full-suite invocation.
- The corrected focused run had 5 passed / 1 initial data-loading timeout (390 EN, before any reorder action). The later complete suite passed that case and the other five new reorder cases.
- Final git diff check: exit 0; tracked worktree clean. Remote integration/preview remains pinned at c31fe5e1914c5daff4cca83427b6caa0aca9d41a.

Additional exact browser commands (same exported environment as above):

```sh
LIST_V2_OUTPUT="$TMPDIR/e2e-focused" bun run test:list-v2-acceptance --grep '#292'
LIST_V2_OUTPUT="$TMPDIR/e2e-focused-final" W29_PORT=19432 bun run test:list-v2-acceptance --grep '#292'
LIST_V2_OUTPUT="$TMPDIR/e2e-rerun" bun run test:list-v2-acceptance --grep 'paging: 200% text boundary 1110 cs page 1000'
```

Machine-readable counts: `verification.json`. Full raw outputs: `frontend-unit.log`, `generated-unit.log`, `typecheck.log`, `lint.log`, `locale-parity.log`, `head-build-final.log`, `access.log`, `e2e-final.log`, `e2e-rerun.log`; browser JSON reports are under `e2e-final/results.json` and `e2e-rerun/results.json`. Original failures, traces and runtime diagnostics are retained.

Archive root: `~/.sitebrew-work/evidence/codex-wr-github-jakubknejzlik-workbase-sdk-292-s1-impl-wr-c8a777aa/`.
