# SDK 0.4.2 release preparation

The patch candidate coordinates `@workbasehq/core`, `@workbasehq/plugins` and
`@workbasehq/mcp` at **0.4.2**, with matching `CORE_VERSION`, plugins core peer
and lockfile. Private console workspaces ship through plugins and are not
separate published packages. The standalone MCP template keeps `{{SDK_VERSION}}`
placeholders so its generated manifests use the selected SDK version. See the
[0.4.2 changelog](../../CHANGELOG.md), [0.4.0 migration notes](migration-0.4.0.md)
and [runnable Workers configuration](../../packages/core/examples/README.md).

## Candidate scope

Start at main `1554698fbc1dbfc132fde1f70de1ebde9dbed366` (SDK 0.4.1).
Merge the complete run-start `integration/preview` tip
`7bd77c241da250c3e6e96b0af5b0ac65ac1a926e` into `release/sdk-v0.4.2`
with a normal merge. Do not silently omit or cherry-pick preview changes.
Source of scope: [release tracker #340](https://github.com/jakubknejzlik/workbase-sdk/issues/340).

The expected fixes are PR #338 (issue #321), PR #335 (issue #325), PR #337
(issue #336), and A1 PR #331 (issue #315). Additional product changes present
in the pinned delta are PR #287 (list preferences), PR #313 (instance-local
SDK initialization), and PR #320 (shared form lifecycle). PR #330 synchronizes
0.4.1; original integration commits for already released fixes also remain in
ancestry. The preparation handoff lists every PR and SHA and flags this scope.
A2/A3 parity and identifier-copy follow-up #339 are outside the pinned tip.

## Preparation checks

Local preparation runs frozen install, typecheck, lint, version consistency,
core/plugins version and validator tests, and serial console-generated and
frontend-console suites with a 15-minute cap each. Retain exact commands, exit
codes and skipped/failed gates in the handoff. Hosted release-PR CI is the main
gate; JARVIS opens the PR from the decision session and reports its exact-head
run URL and conclusion. Baseline failures are not a waiver.

Use only the existing maintainer vocabulary file for private-term guards; never
print or commit its contents. Run `git diff --check`, redacted gitleaks scans
of the branch diff and release ancestry, SDK boundary and public scans.
Never weaken scan policies or add exceptions. See [CONTRIBUTING.md](../../CONTRIBUTING.md).
Inherited A1 font/scanner policy changes remain part of the reviewed preview
merge; preparation adds no scanner, workflow, skip or allowlist changes.

## Phase 2: hosted validation and release evidence

The archive-only local rehearsal command is:

```sh
bash scripts/sdk-pack.sh --pack-only
```

Retain `dist-sdk/PROVENANCE.json`. Source commit, console asset-tree SHA
(`consoleArtifactsSHA`, `build-meta.json.sha` and HTML stamp), and archive SRI
are separate identities. Archive rehearsal does not replace hosted CI or clean
registry-consumer acceptance. Source: [packer](../../scripts/sdk-pack.sh),
[provenance](../../scripts/sdk-provenance.ts).

Before publication, capture the combined release head with synthetic data in
English at 1440, 1280, 900 and 390 px: worker list, Columns, Saved views, Access
detail, widget table and row drilldown. Retain real PNGs named
`<headSha>-r1-en-<width>-<state>.png` and `<headSha>-r1-manifest.json` containing
file, width, state and sha256. Inspect every image. Judge shell/sidebar geometry
from viewport captures at the top and after scrolling to the end; label any
full-page captures as content-only. Per-fix captures do not validate the combined
release. Keep evidence for JARVIS to upload; the owner must see the combined
head SHA and PNG set before publication.

## Publication handoff (not performed during preparation)

Preparation pushes only `release/sdk-v0.4.2` and creates no PR. JARVIS opens the
release PR toward main with title `Release SDK 0.4.2`, body `Part of #340`, all
included PRs and SHAs, and this status:

> Publication pending: tag sdk-v0.4.2 after green CI, independent review and fresh rendered evidence

Record the release PR URL and hosted CI run URL/conclusion as soon as they exist.
Every mandatory gate must be green at the concrete release SHA. After owner
visibility of the combined SHA/evidence, green hosted gates and independent
review MERGE, the authorized decision session merges and pushes **one** real tag
`sdk-v0.4.2` on the reviewed main commit. No tag, workflow dispatch (including
dry run), merge, publication, deployment or consumer change occurs during
preparation.

Publication order is core → plugins → mcp. The tag workflow pins npm 11.5.1 and
uses GitHub Actions OIDC Trusted Publisher for this repository's `release.yml`
with no environment on all three packages. Real publication passes
`--expect-version 0.4.2 --provenance`. The tag run performs the existing release
gates once; do not dispatch an additional dry run. See
[release.yml](../../.github/workflows/release.yml) and
[sdk-publish.ts](../../scripts/sdk-publish.ts).

Before closing #340 or its fixes, retain exact source/tag, green CI and release
run URLs, all package versions, registry integrity/provenance links, a clean
0.4.2 consumer install proof, console SHA and screenshot identities. Announce
publication only after all three npm packages show 0.4.2 as latest. If retrying,
compare the integrity of an existing version: a publisher skip is not byte
verification. Consumer upgrades/deployments have their own scope. See
[consumption.md](consumption.md).
