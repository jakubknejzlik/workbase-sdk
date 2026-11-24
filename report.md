# Issue 295 implementation evidence

PR: https://github.com/jakubknejzlik/workbase-sdk/pull/306

Candidate: `591de890f1a0888ab0c453ab6cbe7c697c62644d`
Base: `integration/preview` at `c31fe5e1914c5daff4cca83427b6caa0aca9d41a`. Verified remote tip before implementation and after commit.
Issue read first: https://github.com/jakubknejzlik/workbase-sdk/issues/295 (no comments). Owner implementation authorization is recorded in that issue and the job brief.

Default alignment follows schema metadata: string/text/enum left; int/float/number right; date/datetime/bool/ref and related label columns center. Renderer hints and runtime row values do not choose alignment. No alignment setting was added to the list schema; base has no explicit alignment override. Internal table presentation receives the computed alignment. Unconfigured component consumers retain their previous defaults.

Headers follow the column alignment. The existing mapColumn header renders the existing sort/filter controls with its established left/right/center presentation; no new control. Rendered tests retain accessible sort controls and assert sorting behavior. This is compatible with the approved list-v2 pattern.

Approved reference: docs/ui/patterns/list-v2.md, https://github.com/jakubknejzlik/workbase-sdk/issues/222#issuecomment-6994976097 and docs/ui/sdk-ui-definition-of-done.md. Reuse requires no new owner pattern approval. Independent rendered review is pending a separate run; this report issues no visual PASS/FAIL.

## Changed files

- `packages/console-generated/src/list-presentation.ts`
- `packages/console-generated/src/screens.tsx`
- `packages/console-generated/test/list-alignment.test.ts`
- `packages/frontend-console/test/list-renderers.test.tsx`
- `packages/ui/src/data-table/DataTable.tsx`
- `packages/ui/src/data-table/presentation.tsx`

## Environment and exact commands

Working directory: `/Users/jarvis/.sitebrew-work/wr-jobs/jakubknejzlik-workbase-sdk/wr-5c760173`. Bun 1.4.3, Node 25.8.0. Shared BUN_INSTALL_CACHE_DIR was preserved; WORKBASE_KEEP_TMP was never set. Scratch and runtime artifacts use `/tmp/codex-scratch/codex-wr-github-jakubknejzlik-workbase-sdk-295-s1-impl-wr-5c760173`.

Common environment (source `/tmp/codex-scratch/codex-wr-github-jakubknejzlik-workbase-sdk-295-s1-impl-wr-5c760173/env.sh`):

```sh
export TMPDIR='/tmp/codex-scratch/codex-wr-github-jakubknejzlik-workbase-sdk-295-s1-impl-wr-5c760173'
export WORKBASE_PRIVATE_TERMS_FILE=/Users/jarvis/.config/workbase/private-terms.txt
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
export W29_PORT=19595
```

```sh
bun install --frozen-lockfile
bun run typecheck
bun run --cwd packages/console-generated typecheck
bun run lint
bun run check:ci-invariants
python3 "$TMPDIR/locale-check.py"
bun run --cwd packages/console-generated test --maxWorkers=1
bun run --cwd packages/ui test --maxWorkers=1 --testTimeout=30000
bun run --cwd packages/frontend-console test --maxWorkers=2 --testTimeout=30000 --hookTimeout=30000
bun run console:build
PREVIEW_ASSETS=$TMPDIR/base-dist CAPTURE_OUT=$TMPDIR/base CANDIDATE_SHA=591de890f1a0888ab0c453ab6cbe7c697c62644d REVISION=base bun x --no-install playwright test --config "$TMPDIR/preview.config.ts" --max-failures=1
PREVIEW_ASSETS=$TMPDIR/head-dist CAPTURE_OUT=$TMPDIR/head CANDIDATE_SHA=591de890f1a0888ab0c453ab6cbe7c697c62644d REVISION=head bun x --no-install playwright test --config "$TMPDIR/preview.config.ts" --max-failures=1
W29_PORT=19596 LIST_V2_OUTPUT=$TMPDIR/list-v2-acceptance bun run test:list-v2-acceptance
W29_PORT=19597 WB178_OUTPUT=$TMPDIR/application-access WB178_SCREENSHOTS=$TMPDIR/application-access/screenshots bun x --no-install playwright test --config packages/frontend-console/playwright.application-access.config.ts
git diff --check
```

Base was built before edits and preserved at `base-dist/`; base previews were captured before building head. Both use the same synthetic live Worker fixture in `alignment-config.ts`, `alignment-seed.ts`, `alignment-worker.ts`. UI/model/data requests are served by that Worker, without substituted HTML, CSS or client model responses. Synthetic Alex Example row has count 12, date 2026-11-24, Inactive = No, and Example Clinic relation rendered with cell.kind text.

Initial unbounded full unit runs hit timeout failures (frontend: 24 failed / 1136 passed / 1 expected fail; UI: 1 failed / 106 passed). Complete final runs limit concurrency and increase per-test timeout to 30 seconds, without changing assertions. Intermediate serial attempts with the original 5 second timeout were stopped before the final commands. Initial local capture probes failed while setting up the scratch fixture (module mode, supported date declaration, row oracle auxiliary columns, stale Loading title); final captures use shipped readiness guards and compare the five data columns. The local Chromium serializes flex start/end as flow-start/end; the final capture assertion normalizes those equivalent values. All probe logs remain locally archived. The first access e2e attempt used its separate screenshot default; generated EN captures were relocated into task scratch; unrelated CS captures in the shared legacy directory were preserved, and the final run explicitly sets WB178_SCREENSHOTS under scratch.

## Results

| Check | Result |
| --- | --- |
| Frozen install | passed; 658 packages |
| Root + UI + frontend typecheck | passed (final rerun recorded in typecheck-final.log) |
| console-generated typecheck | passed |
| Source lint | passed |
| CI invariants + UI validation | passed |
| Locale parity | passed; 623 canonical keys, EN 639 / CS 659 plural entries, unchanged from base |
| console-generated unit suite | 5 files, 71 passed (15 mapping cases) |
| UI unit suite | 16 files, 107 passed |
| Frontend unit suite | 31 files, 1160 passed + 1 expected failure; includes 31 renderer tests |
| Synthetic rendered browser checks + captures | base 3/3, head 3/3 at 1440 / 900 / 390 EN |
| List v2 acceptance | 187 passed (8.8m), 0 failed, 0 skipped, on Playwright Chromium 145.0.7632.6. |
| Access e2e | final Playwright Chromium 145 run: 4 passed (1.3m). System Chrome 158 complete run: 3 passed, 1 failed (EN 390 keyboard tooltip absent at application-access.spec.ts:53); targeted head retry: 1 passed; base reproduction fails at the same tooltip assertion (Invitation sent), demonstrating baseline instability |
| git diff --check | passed |

Access commands beyond the full run:

```sh
W29_PORT=19597 WB178_OUTPUT=$TMPDIR/application-access-retry WB178_SCREENSHOTS=$TMPDIR/application-access-retry/screenshots bun x --no-install playwright test --config packages/frontend-console/playwright.application-access.config.ts --grep 'en 390'
W29_PORT=19598 PREVIEW_ASSETS=$TMPDIR/base-dist WB178_SCREENSHOTS=$TMPDIR/application-access-baseline/screenshots bun x --no-install playwright test --config "$TMPDIR/access-baseline.config.ts" --grep 'en 390'
```

The base probe copies the unchanged access spec, changes only module imports to locate existing dependencies, and reuses local runtime setup with its asset directory pointing to the preserved base build. No behavioral assertion was weakened. Baseline and head logs retain the exact failure and retry evidence.

## Captures

- `/tmp/codex-scratch/codex-wr-github-jakubknejzlik-workbase-sdk-295-s1-impl-wr-5c760173/base/591de890f1a0888ab0c453ab6cbe7c697c62644d-base-en-1440.png`
- `/tmp/codex-scratch/codex-wr-github-jakubknejzlik-workbase-sdk-295-s1-impl-wr-5c760173/base/591de890f1a0888ab0c453ab6cbe7c697c62644d-base-en-1440-scroll-end.png`
- `/tmp/codex-scratch/codex-wr-github-jakubknejzlik-workbase-sdk-295-s1-impl-wr-5c760173/base/591de890f1a0888ab0c453ab6cbe7c697c62644d-base-en-900.png`
- `/tmp/codex-scratch/codex-wr-github-jakubknejzlik-workbase-sdk-295-s1-impl-wr-5c760173/base/591de890f1a0888ab0c453ab6cbe7c697c62644d-base-en-900-scroll-end.png`
- `/tmp/codex-scratch/codex-wr-github-jakubknejzlik-workbase-sdk-295-s1-impl-wr-5c760173/base/591de890f1a0888ab0c453ab6cbe7c697c62644d-base-en-390.png`
- `/tmp/codex-scratch/codex-wr-github-jakubknejzlik-workbase-sdk-295-s1-impl-wr-5c760173/base/591de890f1a0888ab0c453ab6cbe7c697c62644d-base-en-390-scroll-end.png`
- `/tmp/codex-scratch/codex-wr-github-jakubknejzlik-workbase-sdk-295-s1-impl-wr-5c760173/head/591de890f1a0888ab0c453ab6cbe7c697c62644d-head-en-1440.png`
- `/tmp/codex-scratch/codex-wr-github-jakubknejzlik-workbase-sdk-295-s1-impl-wr-5c760173/head/591de890f1a0888ab0c453ab6cbe7c697c62644d-head-en-1440-scroll-end.png`
- `/tmp/codex-scratch/codex-wr-github-jakubknejzlik-workbase-sdk-295-s1-impl-wr-5c760173/head/591de890f1a0888ab0c453ab6cbe7c697c62644d-head-en-900.png`
- `/tmp/codex-scratch/codex-wr-github-jakubknejzlik-workbase-sdk-295-s1-impl-wr-5c760173/head/591de890f1a0888ab0c453ab6cbe7c697c62644d-head-en-900-scroll-end.png`
- `/tmp/codex-scratch/codex-wr-github-jakubknejzlik-workbase-sdk-295-s1-impl-wr-5c760173/head/591de890f1a0888ab0c453ab6cbe7c697c62644d-head-en-390.png`
- `/tmp/codex-scratch/codex-wr-github-jakubknejzlik-workbase-sdk-295-s1-impl-wr-5c760173/head/591de890f1a0888ab0c453ab6cbe7c697c62644d-head-en-390-scroll-end.png`

Archive: `/Users/jarvis/.sitebrew-work/evidence/codex-wr-github-jakubknejzlik-workbase-sdk-295-s1-impl-wr-5c760173/`. Complete raw command logs, Playwright results, manifests, screenshots and capture fixtures are retained there.
- `/tmp/codex-scratch/codex-wr-github-jakubknejzlik-workbase-sdk-295-s1-impl-wr-5c760173/base/591de890f1a0888ab0c453ab6cbe7c697c62644d-base-en-390-scroll-224.png`
- `/tmp/codex-scratch/codex-wr-github-jakubknejzlik-workbase-sdk-295-s1-impl-wr-5c760173/base/591de890f1a0888ab0c453ab6cbe7c697c62644d-base-en-390-scroll-544.png`
- `/tmp/codex-scratch/codex-wr-github-jakubknejzlik-workbase-sdk-295-s1-impl-wr-5c760173/head/591de890f1a0888ab0c453ab6cbe7c697c62644d-head-en-390-scroll-224.png`
- `/tmp/codex-scratch/codex-wr-github-jakubknejzlik-workbase-sdk-295-s1-impl-wr-5c760173/head/591de890f1a0888ab0c453ab6cbe7c697c62644d-head-en-390-scroll-544.png`

Final list command (browser override cleared to use Playwright Chromium):

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH= W29_PORT=19599 LIST_V2_OUTPUT=$TMPDIR/list-v2-final bun run test:list-v2-acceptance
```

Final access command (Playwright Chromium 145, all four cases):

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH= W29_PORT=19597 WB178_OUTPUT=$TMPDIR/application-access-pinned WB178_SCREENSHOTS=$TMPDIR/application-access-pinned/screenshots bun x --no-install playwright test --config packages/frontend-console/playwright.application-access.config.ts
```

Final unit totals: 52 files; 1338 tests passed + 1 expected failure. Final browser is Playwright Chromium 145.0.7632.6; requested synthetic base/head preview captures retain their separate Chrome 158.0.8127.37 provenance.

## Final branch check

The requested starting base was `c31fe5e1914c5daff4cca83427b6caa0aca9d41a`, used for implementation and base screenshots. During the long checks `integration/preview` advanced to `5cca2e3f1d75022bf51f611db6e3cbf04da6b5d2`. The change still applies cleanly: `git fetch origin integration/preview` followed by `git merge-tree --write-tree HEAD FETCH_HEAD` exited 0 with merge tree `bb808785ce4458a5faff32d58640fb0a65b635f0`. No merge or rebase was performed; the tested PR head remains `591de890f1a0888ab0c453ab6cbe7c697c62644d`. Final worktree is clean and `git diff --check` passes. No failing author gate remains on the final pinned-browser runs; independent visual review remains pending.
