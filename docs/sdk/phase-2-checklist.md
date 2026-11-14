# Phase-2 remote acceptance — instance repository

Copy this checklist into the instance PR and attach evidence there. Every box
starts unchecked: local smoke does not establish remote acceptance. These steps
need the instance repository and operator credentials. Use a disposable `pr-N`
stage and the deployment inputs in [getting-started.md](getting-started.md).

- [ ] 1. Vendor the three coordinated SDK tarballs, verify each sha512 against
  the checked release inventory, update identical `file:vendor/sdk/*.tgz`
  dependencies/overrides and `package-lock.json`, generate/check artifacts in
  order, and open an instance PR. Attach archive digests and checks. Sources:
  [consumption](consumption.md), [inventory](inventory.md),
  [integrity assertions](../../scripts/smoke-template.ts).
- [ ] 2. Deploy `pr-N` by hand with configured Cloudflare/auth/email inputs:
  `WORKBASE_BUILD_SHA=$(git rev-parse HEAD) bun run deploy --stage pr-N` from a
  clean PR head. Record the URL and deployment result. Preview automation is
  deferred (slice 19). Source:
  [standalone deployment scripts](../../packages/mcp/templates/standalone/package.json).
- [ ] 3. Fetch live `/build.json` and verify its `sha` equals the full PR head
  SHA. Attach the response and commit identity. The local smoke uses a synthetic
  40-zero SHA instead of proving a remote head. Sources:
  [public build response](../../packages/core/src/console.ts),
  [local build assertion](../../scripts/smoke-template.ts).
- [ ] 4. Fetch live `/openapi.json`; compare its sha256 with committed
  `openapi.json` and verify matching `x-workbase-config-hash` and revision.
  Run `bun run check:openapi --live <https-origin>` to also match
  `/build.json.openapi`. Attach both digests and metadata. Sources:
  [live verification](../../packages/core/src/openapi/cli.ts),
  [canonical OpenAPI response](../../packages/core/src/openapi/routes.ts).
- [ ] 5. Establish admin and staff sessions via real delivered magic links and
  invite/accept, then verify allowed CRUD and denied cross-org/staff operations
  on the deployed HTTPS origin. Record HTTPS `__Host-` cookie behavior, edge CSP,
  and real D1/queue/email acceptance; local outbox/loopback checks do not cover
  them. There is no role selector or seeded-role acceptance (slice 17 deferred).
  Sources: [runtime composition](../../packages/mcp/templates/standalone/runtime.ts),
  [local session scope](../../scripts/lib/installed-consumer-live.ts).
- [ ] 6. Push and deploy a layout-only change; verify existing data survives.
  Then edit an already applied migration and push it in the disposable stage;
  record the history mismatch, explicitly reset that stage's database by hand and replay the
  complete SDK → plugins → domain migration chain before verifying it again.
  Keep/reset automation is deferred (slice 17); there is no template reset
  command. Sources:
  [history checks](../../packages/core/src/infra/d1-migrations.ts),
  [migration orchestration](../../packages/core/src/infra/instance-migrations.ts).
- [ ] 7. On PR close, manually run `bun run remove --stage pr-N` (`sst remove`),
  verify stage resources are removed, then recreate the same disposable stage
  and verify fresh migrations and login. Attach removal/recreation results;
  close cleanup automation is deferred (slice 19). Production retention/protection
  is a different policy. Sources:
  [remove script](../../packages/mcp/templates/standalone/package.json),
  [stage removal policy](../../packages/mcp/templates/standalone/sst.config.ts).
- [ ] 8. Jakub reviews the PR, archive/artifact identity, remote results and
  cleanup/recreation evidence; record the review before accepting phase 2.
