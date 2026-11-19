# Consuming the V3 SDK candidate

This runbook describes the 0.4.0 release candidate. Publication is pending green
CI and review; see [release.md](release.md) and [migration notes](migration-0.4.0.md).
The SDK version,
artifact inventory and limits of local measurement are in [inventory.md](inventory.md).
See [getting-started.md](getting-started.md) for authoring and deployment inputs.

## Install three tarballs

With the maintainer vocabulary available, run `bash scripts/sdk-pack.sh` in the SDK
checkout. It stages console assets, packs core → plugins → mcp, writes
`dist-sdk/PROVENANCE.json`, checks the boundary, and runs the browser, export and
installed-template smokes. The vocabulary guard fails closed; an unsuccessful pack
does not establish a release set. Sources:
[packer](../../scripts/sdk-pack.sh), [provenance](../../scripts/sdk-provenance.ts).

Use a separate tools directory with dependencies and matching overrides pointing
to those three archives to obtain `node_modules/.bin/workbase`. Then initialize:

```sh
workbase init --root <dir> --id <id> --target cloudflare-github
```

Init copies authored files and pins the SDK versions; it does not install, generate
or deploy. In the initialized Instance, copy the three archives to `vendor/sdk/`.
Replace only the SDK dependencies and add identical root overrides; keep all other
template dependencies. For the current coordinated version:

```json
{
  "dependencies": {
    "@workbasehq/core": "file:vendor/sdk/workbasehq-core-0.4.0.tgz",
    "@workbasehq/plugins": "file:vendor/sdk/workbasehq-plugins-0.4.0.tgz",
    "@workbasehq/mcp": "file:vendor/sdk/workbasehq-mcp-0.4.0.tgz"
  },
  "overrides": {
    "@workbasehq/core": "file:vendor/sdk/workbasehq-core-0.4.0.tgz",
    "@workbasehq/plugins": "file:vendor/sdk/workbasehq-plugins-0.4.0.tgz",
    "@workbasehq/mcp": "file:vendor/sdk/workbasehq-mcp-0.4.0.tgz"
  }
}
```

Run `npm install --ignore-scripts --no-audit --no-fund` to create
`package-lock.json`, then `npm ci --ignore-scripts --no-audit --no-fund`. Commit the
vendor archives and lock together. The smoke verifies unchanged lock bytes, each
archive's sha512 integrity, exactly one nonsymlink copy of each SDK package, and no
dependency escaping the consumer. It also rejects `workspace:`, `ui-v3` and
`test-support` in the lock. Registry/prerelease acceptance remains deferred.
Sources: [installed-template smoke](../../scripts/smoke-template.ts),
[artifact assertions](../../scripts/lib/installed-consumer-live.ts).

## Generate artifacts in order

From the Instance directory, after authoring config/schema/access/UI/locales:

```sh
bun run migrate:plan --init
bun run access:lock
bun run openapi:write
bun run check
bun run typecheck
```

Schema planning writes `schema.lock.json` and `migrations/0001_r1.sql`; access
auditing needs that lock and writes `access.lock.json` and `access.lock.md`.
OpenAPI follows and stamps revision and `x-workbase-config-hash`.
Commit these artifacts with `package-lock.json`. `check` runs schema, access,
OpenAPI and UI checks. `typecheck` generates UI first under ignored
`.workbase-ui*`. `bun run build:console` validates and bundles Instance routes,
browser components and dictionaries with public SDK renderer/auth/CSS exports
into `dist/console`. Both Wrangler and SST rebuild and serve that directory.
ADR 0008 per-Instance delivery supersedes #45's shared prebuilt scaffold. The
emitted bundle SHA changes with page/dictionary edits at a fixed schema revision
and is shared with `/build.json`; no `WORKBASE_BUILD_SHA` is required. For later physical schema changes use
`bun run migrate:plan --base <git-ref>` and review generated diffs. Sources:
[template scripts](../../packages/mcp/templates/standalone/package.json),
[artifact/asset assertions](../../scripts/smoke-template.ts).

## V3 authoring through MCP

After installing the SDK dependencies, `.mcp.json` provides
`workbase_config` alongside the separate data and ops servers. Launch it from the
Instance directory: it runs the installed `workbase config --root .` and needs no
API credentials or optional environment variables. Remote data/ops credentials
remain separate; their app origin can be `https://app.example.test`. Existing
Instances must merge the config entry manually because init preserves `.mcp.json`.

For a fresh scaffold, call `initialize_instance` with the Instance selector and
`mode: "preview"`, review the plan, then call `mode: "apply"` with the returned
`planHash`. Preview writes nothing; apply publishes the initial schema, migration,
OpenAPI and access artifacts locally. Shell generation remains an alternative.

Call `inspect_schema` with the Instance selector, then `propose_composition` with
`instance`, the inspected `baseRevision` and `changes`. Use `set_plugin` to add or
configure a built-in plugin (plugin `console` enables the console),
`set_interactive` to set interactive login, `set_system_access` to replace system
grants, `set_entity_access` to replace a role's entity access, and
`set_account_link` to set an entity's invitation role. `propose_change` accepts
these V3 kinds too; do not mix them with legacy kinds.

Continue with `validate` → `preview_migration` → `apply_to_disposable` → `promote`.
Pass `proposalId` at each step and the inspected revision as `expectedRevision` to
`promote`. Review validation requirements, exact sources, access-lock changes and
plugin SQL before disposable verification. Source or dependency changes require
validation and verification again. Promotion writes reviewable local sources and
access locks, plus an existing OpenAPI artifact for access edits. It preserves the
domain revision, schema lock and domain migration history; it does not apply to a
live DB or deploy. Review and commit through the approved PR process, then deploy
through SDK migration orchestration.

V3 domain-change promotion is unsupported (`v3_promote_unsupported`). Physical
schema changes require reviewed source edits and migration generation. Custom
plugins/commands, plugin removal and role definitions also require reviewed source
changes. See [composition and access](mcp-composition.md) for the input contract.

## Bootstrap a fresh local Worker and D1

The template has no bootstrap command. This operator recipe supplies the adapter
used by the smoke; it does not change the template. Use a disposable, fresh local
database, the generated artifacts above and the installed consumer dependencies.
Plain Wrangler domain migrations do not initialize SDK/plugin tables, and
`workbase-migrate` is the Cloudflare HTTP client, not a local-binding CLI. Sources:
[live bridge](../../scripts/lib/installed-consumer-live.ts),
[migration orchestration](../../packages/core/src/infra/instance-migrations.ts),
[HTTP CLI](../../packages/core/src/infra/bin.mjs).

Create a private `.dev.vars` with synthetic local values (never reuse these for a
deployed environment), using the same port as the Worker:

```sh
cat > .dev.vars <<'ENV'
BETTER_AUTH_SECRET=synthetic-access-secret-at-least-32
AUTH_BASE_URL=http://127.0.0.1:9290
OPS_TOKEN=example-ops
ENV
chmod 600 .dev.vars
mkdir -p .smoke
cat > .smoke/local-db-bootstrap.ts <<'TS'
import assert from 'node:assert/strict'
import { getPlatformProxy } from 'wrangler'
import { migrateInstance, readMigrationFiles, type D1Query } from '@workbasehq/core/infra'
import { splitStatements } from '@workbasehq/core/kernel/migrations'
import { KernelRegistry } from '@workbasehq/core/kernel/registry'
import config from '../runtime'

const proxy = await getPlatformProxy<{ DB: D1Database }>({
  configPath: './wrangler.jsonc',
  persist: { path: '.wrangler/state/v3' },
  remoteBindings: false,
})
try {
  const db = proxy.env.DB
  const query: D1Query = sql => db.batch(splitStatements(sql).map(sql => db.prepare(sql)))
  const files = await readMigrationFiles('./migrations')
  const kernel = new KernelRegistry(config)
  const first = await migrateInstance(query, files, kernel)
  console.log('initial:', first)
  console.log(await db.prepare('SELECT namespace,name FROM _plugin_migrations ORDER BY rowid').all())
  console.log(await db.prepare('SELECT filename FROM _migrations ORDER BY filename').all())
  console.log(await db.prepare('SELECT revision,core_version FROM instance_meta').all())
  const repeated = await migrateInstance(query, files, kernel)
  assert.equal(repeated.applied, 0)
  console.log('rerun:', repeated)
} finally {
  await proxy.dispose()
}
TS
WRANGLER_SEND_METRICS=false node --import tsx .smoke/local-db-bootstrap.ts
```

For the fresh scaffold expect SDK receipts first in `_plugin_migrations`, then
plugin receipts, then domain `0001_r1.sql` in `_migrations`, revision 1, and a
zero-change rerun. `splitStatements` preserves trigger bodies; `db.batch` keeps a
migration and its receipt transactional. The proxy path ends in `/v3` because
Wrangler's CLI appends `/v3` to `--persist-to`; pointing both at the same literal
path would select different databases. The smoke additionally asserts unchanged
ledger snapshots. Sources: [live bridge](../../scripts/lib/installed-consumer-live.ts),
[D1 migration batches](../../packages/core/src/infra/d1-migrations.ts).

Start the consumer's installed Wrangler to serve the installed SDK console assets:

```sh
WRANGLER_SEND_METRICS=false node node_modules/wrangler/bin/wrangler.js dev \
  --local --ip 127.0.0.1 --port 9290 --inspector-port 0 \
  --persist-to .wrangler/state --log-level error
```

Open `http://127.0.0.1:9290` for same-origin console and API requests. No Vite server
or console build is needed. For sign-in, first-owner ops provisioning and staff
invitations, follow [onboarding without real mail](onboarding.md); the
[mailbox contract](dev-mailbox.md) describes a local sidecar sharing this D1 state.
The smoke invokes the installed mailbox handler against that shared database,
completes `/me/profile`, provisions organizations through `/internal/organizations`
with `allowCreate: false`, then checks staff invite/accept and isolation.
There are no identity SQL seeds or role selector. Sources:
[live sessions](../../scripts/lib/installed-consumer-live.ts),
[runtime composition](../../packages/mcp/templates/standalone/runtime.ts).

Treat outbox links as credentials. The automated harness explicitly forwards the
real Secure cookies for Playwright API calls over HTTP loopback; this is not an
HTTPS cookie-enforcement test. Source:
[session helper](../../scripts/lib/installed-consumer-live.ts).

## What the installed-consumer smoke checks

`bun scripts/smoke-template.ts --directory dist-sdk` uses the same initialized,
tarball-installed consumer throughout. Its unpacked fixture adds cs translations
and a nullable text field; the shipped template remains English-only. Beyond
generation, console asset checks and migrations, it checks persistence across
Worker restart, CRUD, omitted versus null PATCH, stale-write 409, 26-row paging
and display-field search,
cross-org denial, and loss of staff row access after unlink. Sixteen renders cover
four routes × 1280/390 widths × cs/en with translated headings, no horizontal
overflow or page errors. Protected account fields stay out of new/edit forms;
routes/fields match the manifest, generated route tree, lock and OpenAPI. It checks
separate config, data and ops MCP configuration and absence of archive/versions directories.
Sources: [smoke](../../scripts/smoke-template.ts),
[live assertions](../../scripts/lib/installed-consumer-live.ts).

Post-install commands in steps 1–7 run under OS network isolation with JS guards;
bootstrap, installation, initial init and npm ci do not; the repeated
init in step 7 is isolated. Live steps 8–9 run outside that
isolation with a JS loopback-literal guard and a browser origin filter for routed
HTTP. WebSockets are not covered by that filter; native workerd/Chromium networking
is outside the JS guard. This is not kernel isolation for the live phase. Sources:
[isolation wrapper](../../scripts/lib/smoke-network.ts),
[live network guard](../../scripts/lib/installed-consumer-network.cjs),
[browser filter](../../scripts/lib/installed-consumer-live.ts).

The live phase runs in a detached supervisor's process group. A preload keeps
Node-launched descendants in that group; a stdin pipe connects its lifetime to
the parent. Normal completion or pipe closure triggers a group SIGTERM followed
by SIGKILL after 12 seconds. The inner cleanup closes browser contexts, browser,
Worker and D1 proxy with a 10-second bound. The parent has a 240-second live
deadline, allows 13 seconds for the supervisor to settle, and requires both a zero
live result and the final teardown marker before reporting success. Sources:
[supervisor](../../scripts/lib/installed-consumer-supervisor.cjs),
[process preload](../../scripts/lib/installed-consumer-processes.cjs),
[parent/inner cleanup](../../scripts/lib/installed-consumer-live.ts).

Set `WORKBASE_EVIDENCE_DIR` to an absolute directory outside the repo and archive
directory for optional PNGs and timing JSON. Timings cover install, npm ci,
typecheck and live assertions with OS/Node/Bun metadata; no
performance thresholds are enforced. Source:
[evidence and timing](../../scripts/lib/installed-consumer-live.ts).

## Known gaps

- No real Cloudflare D1, queues or email-delivery proof: local D1 and outbox links
  supply the local acceptance path.
- No HTTPS `__Host-` cookie enforcement or edge CSP proof; loopback HTTP and
  built-script checks do not establish those properties.
- No `sst deploy`: the smoke bundles/imports SST configuration and checks an
  offline provision plan without registering resources.
- Supported metadata endpoints `/schema`, `/console-info` and console-model
  remain mounted. The smoke checks browser request avoidance; unknown paths
  follow normal SPA handling and are not guaranteed to return 404.

Sources: [smoke scope](../../scripts/smoke-template.ts),
[local live implementation](../../scripts/lib/installed-consumer-live.ts),
[mounted routes](../../packages/core/src/app.ts). Registry installation, config-writer
removal, seeded-role/reset automation and preview/cleanup automation remain deferred;
see [CHANGELOG](../../CHANGELOG.md) and the [phase-2 checklist](phase-2-checklist.md).
