# Local list v2 evidence harness

Part of #233. This harness collects evidence and runs in default SDK CI, including the three #233 regression scenarios; it issues no visual verdict. #250 owns the renderer, calendar and existing saved-views spec follow-up.

From the repository root:

```sh
bun install --frozen-lockfile
bun run console:build
bun run test:list-v2-acceptance
```

The acceptance script preserves the caller's exported TMPDIR and LIST_V2_OUTPUT. TMPDIR defaults to the OS temporary directory; create any custom TMPDIR before running the script. Never set WORKBASE_KEEP_TMP. Use a free W29_PORT when the default is occupied. Requires local Chromium (Playwright install or PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH), Wrangler and free port 19429 (W29_PORT overrides).

An exported LIST_V2_OUTPUT selects the exact evidence directory outside git, without adding a suffix. Otherwise each CLI run creates a fresh `list-v2-acceptance-<random>` directory under Node's `os.tmpdir()`, which honours an exported TMPDIR on Unix. The Playwright config exports the chosen directory before workers spawn, so the coordinator and all workers share it. Config loading prints `[list-v2] Evidence output: <directory>` to the CLI console, including for `--list`. CI continues to set LIST_V2_OUTPUT to `${{ runner.temp }}/list-v2-acceptance`, so its evidence and artifact upload locations are unchanged. It contains full-page EN captures at 1440×900 and 390×900, manifest.json, results.json and retained failure traces. When setting LIST_V2_OUTPUT explicitly, choose a fresh directory per revision; the manifest merges entries so failed scenarios do not erase earlier evidence. Capture provenance includes commit, working diff, asset digest, fixture digest and browser version. Missing capture entries are missing evidence, never a pass. CS is deferred to keep this initial matrix focused; EN uses shipped locale copy.

The seed has 47 fixed workers sorted by name/ID; staff can read only the 11 linked to staff. Team lookup also has an actual restricted grant. All/active/inactive/archived/pending views have distinct memberships (archived is zero). `list-v2-data.ts` computes expected IDs/counts directly from the seed without importing query compilation or reading UI values. A minimal denied member role makes the existing generated invitation controls available to the administrator; it grants staff no additional reads. Admin has invitation authority; staff has none. Access checks use local Worker authorization. Sessions expire relative to runtime; domain dates and rows are fixed.

Normal captures await data, row-access hydration, fonts and finite animations; infinite loading skeleton animations are disabled by the screenshot operation. Loading and error are explicit browser request injections only: POST /query for worker + includeTotal is held or fulfilled with synthetic HTTP 503. The manifest records each injection. No fake data, shell, model, or style is substituted. Same-tab actor checks replace the authenticated session header and wait for the shipped organization/model refresh; no reload or query-client mutation.

Review failures in results.json/manifest.json with the retained traces. Product failures must not weaken the oracle. #250 visual follow-up remains separate; fill the rubric only during independent visual review.

Runtime teardown retains `worker.log` and writes `runtime-<port>-<pid>/runtime-diagnostics.json` in the current Playwright test output directory when a test fails or a runtime exits/disconnects unexpectedly. The record includes test identity, worktree, ports, wrapper/Wrangler/workerd identities and PGID, timestamps, redacted stderr tails, and native child exit code/signal observed inside Wrangler. Missing native exit events are explicitly unavailable; wrapper status is never substituted. Passing runtimes remove their temporary state/log and leave a compact diagnostics record. No environment or full command lines are recorded. Teardown signals only its own detached group; native children are stopped first to allow their parent to record exit events. These diagnostics preserve evidence; they do not establish or fix the cause of historical HTTP 500s.

Numbered root-list pages use the one-based `page` URL search parameter (omitted for page 1). Copied URLs, reload and Back/Forward restore the same page and committed settings. Invalid pages or pages beyond the configured offset cap reset to page 1; changing settings, applying a personal view or changing actor resets paging. Saved views remain settings-only. The toolbar uses Saved views, Columns and Filters (Uložené pohledy, Sloupce and Filtry); sorting stays in column headers. Actor-bound embedded/calendar cursors stay in browser history or card state and are never copied into URLs.

#271 stylesheet readiness is checked after every full navigation/reload, including
copied-URL pages, and again before settled-page assertions. A real SDK CSS link
must have a successful observed response, a loaded CSSStyleSheet, and applied
`min-w-0` / `overflow-hidden` styles on the SDK list container. Missing/failed CSS
fails with `SDK stylesheet readiness` before visual or geometry checks. Native
popup assertions retain their original timing and geometry oracles: a targeted
blocked-CSS probe found stale click coordinates, not delayed popup opening.

The dedicated `playwright.list-v2-readiness.config.ts` checks normal CSS, an
injected CSS 500, and HTTP 200 without SDK styles. These guard regression checks
are separate from the unchanged 147-case acceptance inventory; injections never
provide a passing acceptance path.
A cache-revalidated HTTP 304 is also allowed, but only while loaded-sheet and
applied-style checks pass. The dedicated reload regression records both the
initial 200 and subsequent 304; 304 alone never proves stylesheet readiness.
