# SDK release preparation

Run the checks in CONTRIBUTING.md. The public CI workflow builds and packs exactly
@workbasehq/core, @workbasehq/plugins and @workbasehq/mcp, then scans the source
and archives. The release.yml workflow performs the same checks and rehearses
with `bun scripts/smoke-mcp-template.ts --directory dist-sdk` before publishing
the same archives from its single ubuntu-24.04 job. Dispatch with dry_run=true
(the default) to validate without uploading, or use an sdk-v<version> tag.

The first public release is sdk-v0.2.11. Bump the three SDK manifest versions
together with core CORE_VERSION and the plugins core peer for future releases.
The release job pins npm 11.5.1 and authenticates only through GitHub Actions
OIDC (id-token: write), with npm Trusted Publisher configured for
jakubknejzlik/workbase-sdk, release.yml, and no environment on all three packages.
Real publication passes --provenance; the default dispatch is a dry run.
The publisher defaults to --provenance=false without the opt-in flag. Enabling
it requires GITHUB_ACTIONS=true, ACTIONS_ID_TOKEN_REQUEST_URL and the exact
public GITHUB_REPOSITORY above, including for dry runs. Local rehearsal uses
`bun scripts/sdk-publish.ts --directory dist-sdk --dry-run --expect-version 0.2.11`.
Publication order remains core → plugins → mcp. After the hosted dry run passes,
tag that same commit sdk-v0.2.11 and verify npm provenance for all three packages.
