# SDK candidate inventory

This inventory describes the integration branch at `f9b800e`, without publishing
or deploying. Consumption instructions are in [consumption.md](consumption.md);
remote acceptance belongs to the [instance checklist](phase-2-checklist.md).

## Locally measured source identity

| Field | Value | Command / source |
| --- | --- | --- |
| Coordinated SDK version | `0.2.15` for core, plugins and mcp | `node -e 'for (const p of ["core","plugins","mcp"]) console.log(p,require("./packages/"+p+"/package.json").version)'` |
| Integration SHA | `f9b800e93cdf0350c6518e4b825e606f0022c34f` | `git rev-parse f9b800e` |
| Producer `bun.lock` sha256 (hex) | `180184306f610836f4cdf16d2a8029c45c15926f8260de439282dc7f989fadf9` | `shasum -a 256 bun.lock` |

The producer lock hash identifies tool dependency resolution; it is not the
installed consumer's `package-lock.json` hash. Source versions are declared in
[core](../../packages/core/package.json), [plugins](../../packages/plugins/package.json)
and [mcp](../../packages/mcp/package.json). The smoke independently asserts that
the three archive versions agree and match installed versions
([scripts/smoke-template.ts](../../scripts/smoke-template.ts)).

## Release artifacts and generated consumer

Local `bash scripts/sdk-pack.sh` exited **1** because `WORKBASE_PRIVATE_TERMS` was
unavailable. Its console-build imports load the vocabulary guard before staging or
packing. The subsequent `bun scripts/smoke-template.ts --directory dist-sdk` exited
**1** because no fresh `dist-sdk` existed. No fresh tarball or consumer artifact
hash is claimed, and no earlier supplemental archive is treated as this release
set. Sources: [packer](../../scripts/sdk-pack.sh),
[private vocabulary guard](../../scripts/lib/private-terms.ts),
[smoke](../../scripts/smoke-template.ts).

Each pending value below is **computed in CI** by the exact step
`run: bash scripts/sdk-pack.sh` in job `check` of
[.github/workflows/ci.yml](../../.github/workflows/ci.yml), with
`WORKBASE_PRIVATE_TERMS` supplied. The same command also runs in job `release` of
[release.yml](../../.github/workflows/release.yml). This identifies where values
are computed; it does not claim that a hosted run has passed or captured them.

| Field | Value | Computation within that CI step |
| --- | --- | --- |
| `workbasehq-core-0.2.15.tgz` sha512 | computed in CI | `sdkArchives()` in `scripts/sdk-provenance.ts`; base64 SRI in `dist-sdk/PROVENANCE.json`. |
| `workbasehq-plugins-0.2.15.tgz` sha512 | computed in CI | Same `sdkArchives()` computation. |
| `workbasehq-mcp-0.2.15.tgz` sha512 | computed in CI | Same `sdkArchives()` computation. |
| Consumer `package-lock.json` sha256 | computed in CI | `scripts/smoke-template.ts` step 2 hashes lock bytes before/after npm ci; the final success line prints the hex hash. |
| Consumer `openapi.json` `x-workbase-config-hash` | computed in CI | Smoke step 3 runs `bun run openapi:write` and compares the property with packaged `loadConfig('./config.ts').configHash`. |

The config hash is the overlaid smoke consumer's value, not a universal SDK hash.
By default the smoke removes its temporary consumer on exit and does not print
this property or persist its OpenAPI/lock artifacts as CI uploads. PNG/timing
opt-in does not retain them. Once archives exist, obtain their recorded SRI hashes
and retain an operator rehearsal's generated consumer with:

```sh
bun -e 'import { sdkArchives } from "./scripts/sdk-provenance"; console.log(JSON.stringify(sdkArchives("dist-sdk"), null, 2))'
WORKBASE_KEEP_TMP=1 bun scripts/smoke-template.ts --directory dist-sdk
```

Use the printed retained scratch path's `instance/` directory to run
`shasum -a 256 package-lock.json` and
`node -p 'require("./openapi.json")["x-workbase-config-hash"]'`.
Retained consumers contain synthetic sessions and outbox links; remove them after
recording the inventory.

Sources: [provenance hashing](../../scripts/sdk-provenance.ts),
[consumer hashing/generation/cleanup](../../scripts/smoke-template.ts),
[temporary-directory retention](../../scripts/lib/test-temp-dir.mjs),
[evidence payload](../../scripts/lib/installed-consumer-live.ts).

## Tool pins and local observations

| Tool / setting | Committed pin | Source |
| --- | --- | --- |
| Bun | `1.4.3` | Root and standalone `packageManager`. |
| Node | `25.8.0` | CI and release `actions/setup-node`. |
| Wrangler | `4.126.0` | Root and standalone devDependencies. Root has a patch; the installed consumer is unpatched. |
| SST | `4.17.1` | Root and standalone devDependencies. |
| TypeScript | Standalone `6.0.3`; root `^6.0.0`, frozen lock resolves `6.0.3` | Standalone/root manifests and `bun.lock`. |
| Playwright / test | `1.58.2` | Root devDependencies; root Playwright drives the consumer browser phase. |
| Vite | `7.3.1` | Standalone devDependencies. |
| tsx | `4.23.15` | Root and standalone devDependencies. |
| Router generator / module lexer | `1.146.2` / `2.3.2` | Standalone devDependencies. |
| Pulumi / command | `3.246.0` / `1.2.1` | Standalone devDependencies. |
| Cloudflare SST provider | `6.19.0` | Standalone `sst.config.ts`. |
| Wrangler compatibility date | `2026-08-01` | Standalone `wrangler.jsonc`. |
| npm | Release CLI `11.5.1`; CI check job uses setup-node's bundled npm | Release install step; no separate check-job npm pin. |
| gitleaks | CI/release `8.24.3` | Verified binary installation steps. |
| CI runner | `ubuntu-24.04` | CI and release job `runs-on`. |

Read the declarations with `node -p 'JSON.stringify(require("./package.json"), null, 2)'`
and `node -p 'JSON.stringify(require("./packages/mcp/templates/standalone/package.json"), null, 2)'`;
inspect the workflow/config sources below for the remaining pins. Local
`bun --version`, `node --version`, `npm --version`, `gitleaks version` returned
`1.4.3`, `v25.8.0`, `11.11.0`, `8.30.1`, respectively. Local npm and gitleaks differ
from release/CI pins; these observations are not hosted-CI evidence.

Sources: [root manifest](../../package.json), [producer lock](../../bun.lock),
[standalone manifest](../../packages/mcp/templates/standalone/package.json),
[SST config](../../packages/mcp/templates/standalone/sst.config.ts),
[Wrangler config](../../packages/mcp/templates/standalone/wrangler.jsonc),
[CI workflow](../../.github/workflows/ci.yml),
[release workflow](../../.github/workflows/release.yml).
