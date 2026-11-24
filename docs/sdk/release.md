# SDK 0.4.1 release preparation

The patch candidate coordinates `@workbasehq/core`, `@workbasehq/plugins` and
`@workbasehq/mcp` at **0.4.1**, with matching `CORE_VERSION`, plugins core peer
and lockfile. Private console workspaces ship through plugins and are not
separate published packages. See the [0.4.1 changelog](../../CHANGELOG.md),
[0.4.0 migration notes](migration-0.4.0.md) and
[runnable Workers configuration](../../packages/core/examples/README.md).

## Candidate scope

Start at main `43fbe4daa868283338e0524e8494e5d5eeb1aa9c` (0.4.0). Cherry-pick
only the reviewed squash commits for #285, #286, #289, #290–#295, #298 and
#301–#304, in integration/preview order. The handoff records issue, PR, original
squash SHA and release cherry-pick SHA. Do not merge the whole preview branch.
Source of scope: [release tracker #307](https://github.com/jakubknejzlik/workbase-sdk/issues/307).

An over-budget dashboard widget still returns no data. Failure isolation keeps
other widgets rendering and gives the refused widget a localized explanation;
the machine code remains in JSON. Consumer reference columns stay omitted and
no budget or limit is raised. Literal 0.4.0 widget captions remain supported.

## Preparation checks

Mirror [.github/workflows/ci.yml](../../.github/workflows/ci.yml) locally: frozen
install, lint, root/UI/frontend typecheck, CI invariants, full `bun run test`
(including infra, tools and frontend), List v2 acceptance, MCP and locale checks.
Verify combined console-model/widgets and widget browser coverage, literal
0.4.0 captions, Zero/Nonzero/Missing stats, error cards next to linked data
widgets, and shared header/body tracks. Every mandatory gate must pass on the
concrete release head; baseline failures are not a waiver.

Use only the existing maintainer vocabulary file for private-term guards; never
print or commit its contents. Run `git diff --check`, a redacted gitleaks branch
scan, SDK boundary and public scans. Never weaken scan policies or add exceptions.
See [CONTRIBUTING.md](../../CONTRIBUTING.md).

Run the archive-only rehearsal:

```sh
bash scripts/sdk-pack.sh --pack-only
```

Retain `dist-sdk/PROVENANCE.json`. Source commit, console asset-tree SHA
(`consoleArtifactsSHA`, `build-meta.json.sha` and HTML stamp), and archive SRI
are separate identities. Archive rehearsal does not replace hosted CI or clean
registry-consumer acceptance. Source: [packer](../../scripts/sdk-pack.sh),
[provenance](../../scripts/sdk-provenance.ts).

Capture the combined release head with synthetic data in English at 1440, 1280,
900 and 390 px: worker list, Columns, Saved views, Access detail, widget table
and row drilldown. Retain real PNGs named `<headSha>-r1-en-<width>-<state>.png`
and `<headSha>-r1-manifest.json` containing file, width, state and sha256. Inspect
every image. Keep the evidence until JARVIS uploads it to the Workbase thread;
owner must see the combined head SHA and PNG set before publication.

## Publication handoff (not performed during preparation)

Preparation pushes only `release/sdk-v0.4.1`. JARVIS opens the release PR, runs
full hosted CI and independent release review at the exact head, merges and tags.
Record the release PR URL and hosted CI run URL/conclusion as soon as they exist.
Hosted tools and every other mandatory gate must be green at the release SHA.

After owner visibility of the combined SHA/evidence, green hosted gates and
independent review MERGE, push **one** real tag `sdk-v0.4.1` on the reviewed main
commit. Do not additionally dispatch a dry-run workflow: the tag run performs
all existing release gates once. No tag, dispatch or publication occurs during
preparation.

Publication order is core → plugins → mcp. The tag workflow pins npm 11.5.1 and
uses GitHub Actions OIDC Trusted Publisher for this repository's `release.yml`
with no environment on all three packages. Real publication passes
`--expect-version 0.4.1 --provenance`. Manual dispatch is optional and defaults
to dry run; it is not an additional required release step. See
[release.yml](../../.github/workflows/release.yml) and
[sdk-publish.ts](../../scripts/sdk-publish.ts).

Before closing #307 or its fixes, retain exact source/tag, green CI and release
run URLs, all package versions, registry integrity/provenance links, a clean
0.4.1 consumer install proof, console SHA and screenshot identities. Announce
publication only after all three npm packages show 0.4.1 as latest. If retrying,
compare the integrity of an existing version: a publisher skip is not byte
verification. Consumer pins and ID selections are prepared by the owner; consumer
upgrades/deployments have their own scope. See [consumption.md](consumption.md).
