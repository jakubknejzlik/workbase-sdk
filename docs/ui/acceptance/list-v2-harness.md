# Local list v2 evidence harness

Part of #233. This harness collects evidence; it issues no visual verdict and fixes no product behavior. #250 owns the renderer, calendar and existing saved-views spec follow-up.

From the repository root:

```sh
bun install --frozen-lockfile
bun run console:build
bun run test:list-v2-acceptance
```

The opt-in script sets TMPDIR under the dedicated scratch root. Alternatively set TMPDIR to a directory under that root and run `bun x --no-install playwright test --config packages/frontend-console/playwright.list-v2.config.ts` directly. Never set WORKBASE_KEEP_TMP. Requires local Chromium (Playwright install or PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH), Wrangler and free port 19429 (W29_PORT overrides).

LIST_V2_OUTPUT selects an evidence directory outside git. Default: `/tmp/codex-scratch/codex-wr-github-jakubknejzlik-workbase-sdk-233-s1-impl-wr-87bdd668/list-v2-acceptance`. It contains full-page EN captures at 1440×900 and 390×900, manifest.json, results.json and retained failure traces. Use a fresh directory per revision; the manifest merges entries so failed scenarios do not erase earlier evidence. Capture provenance includes commit, working diff, asset digest, fixture digest and browser version. Missing capture entries are missing evidence, never a pass. CS is deferred because the approved screenshots and this matrix require only two widths; EN uses shipped locale copy.

The seed has 47 fixed workers sorted by name/ID; staff can read only the 11 linked to staff. Team lookup also has an actual restricted grant. All/active/inactive/archived/pending views have distinct memberships (archived is zero). `list-v2-data.ts` computes expected IDs/counts directly from the seed without importing query compilation or reading UI values. Admin has invitation authority; staff has none. Access checks use local Worker authorization. Sessions expire relative to runtime; domain dates and rows are fixed.

Normal captures await data, row-access hydration, fonts and animations. Loading and error are explicit browser request injections only: POST /query for worker + includeTotal is held or fulfilled with synthetic HTTP 503. The manifest records each injection. No fake data, shell, model, or style is substituted. Same-tab actor checks replace the authenticated session header and wait for the shipped organization/model refresh; no reload or query-client mutation.

Review failures in results.json/manifest.json with the retained traces. Product failures are candidate GAPs for independent s2 review, not instructions to weaken the oracle. Re-capture on the merged #250 revision before s2. Fill the separate rubric only during independent review.
