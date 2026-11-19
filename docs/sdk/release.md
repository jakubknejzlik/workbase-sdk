# SDK 0.4.0 release preparation

The candidate coordinates `@workbasehq/core`, `@workbasehq/plugins` and
`@workbasehq/mcp` at **0.4.0**, with matching `CORE_VERSION`, plugins core peer
and lockfile. The private console workspaces ship through plugins; they are not
separate published packages. See the [0.4.0 changelog](../../CHANGELOG.md),
[migration notes](migration-0.4.0.md) and
[runnable Workers configuration](../../packages/core/examples/README.md).

The candidate starts at the accepted integration revision `a51c635eb84cf4e4bd128f28f4704e226fdf6e55`
and merges main `cfef8a865331bb65f3a8f41adb2a1ecd7be9a03a`, following the
`release/sdk-v0.3.1` → main pattern. Review
[release PR #256](https://github.com/jakubknejzlik/workbase-sdk/pull/256) and
[#233 ACCEPT](https://github.com/jakubknejzlik/workbase-sdk/issues/233#issuecomment-7018768570).
The acceptance bundle applies to that integration SHA, not rebuilt 0.4.0 archives.
Publication pending: tag + provenance after green CI and review.

## Preparation checks

Run the scoped local checks recorded in the release handoff; full SDK and MCP
suites run in the release PR's CI. Run `git diff --check`, typecheck, lint,
version/validator unit tests, the example test and a redacted gitleaks branch scan.
Use only the existing maintainer vocabulary file for private-term guards; never
print or commit its contents. See [CONTRIBUTING.md](../../CONTRIBUTING.md).

For a local archive-only rehearsal (no publication or full consumer suite):

```sh
bash scripts/sdk-pack.sh --pack-only
```

The public CI workflow builds/packs exactly the three SDK packages, scans source
and archives and runs the full installed-template proof. Archive-only rehearsal
is not a substitute for green CI or registry consumer acceptance. Source commit,
console asset-tree SHA (`consoleArtifactsSHA`, `build-meta.json.sha` and HTML
stamp), and archive SRI are separate identities. Retain `dist-sdk/PROVENANCE.json`
and the CI links in the publication handoff. Source: [packer](../../scripts/sdk-pack.sh),
[provenance](../../scripts/sdk-provenance.ts).

## Publication handoff (pending; not performed during preparation)

After green full CI and maintainer review, select the exact reviewed release
commit. The release workflow runs on `sdk-v*` tags or manual dispatch; do not
trigger it as part of this preparation. Its template rehearsal uses
`bun scripts/smoke-mcp-template.ts --directory dist-sdk`. Publication order is
core → plugins → mcp; the future tag for this version is `sdk-v0.4.0`.

For a separately authorized local publisher dry run against already checked
archives, the version-specific command is:

```sh
bun scripts/sdk-publish.ts --directory dist-sdk --dry-run --expect-version 0.4.0
```

The release job pins npm 11.5.1 and authenticates through GitHub Actions OIDC
(`id-token: write`) using Trusted Publisher for this repository's `release.yml`
with no environment on all three packages. Real tag publication passes
`--expect-version 0.4.0 --provenance`; dispatch defaults to dry run. The publisher
itself defaults to provenance=false unless explicitly opted in, and provenance
requires the hosted Actions identity. See [release.yml](../../.github/workflows/release.yml)
and [sdk-publish.ts](../../scripts/sdk-publish.ts).

Before closing #234, retain exact source/tag, green CI URLs, all package versions,
registry integrity/provenance links, clean npm consumer proof, console SHA and
required screenshot identities. If retrying publication, compare the integrity
of any already existing version: the publisher's skip is not byte verification.
Acceptance and archive rehearsal do not establish registry publication. Consumer
upgrades and deployments need a separate task. See [consumption.md](consumption.md).
