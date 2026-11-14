# Consuming the V3 SDK candidate

This runbook describes the integration branch at `f9b800e`. The SDK version,
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
    "@workbasehq/core": "file:vendor/sdk/workbasehq-core-0.2.15.tgz",
    "@workbasehq/plugins": "file:vendor/sdk/workbasehq-plugins-0.2.15.tgz",
    "@workbasehq/mcp": "file:vendor/sdk/workbasehq-mcp-0.2.15.tgz"
  },
  "overrides": {
    "@workbasehq/core": "file:vendor/sdk/workbasehq-core-0.2.15.tgz",
    "@workbasehq/plugins": "file:vendor/sdk/workbasehq-plugins-0.2.15.tgz",
    "@workbasehq/mcp": "file:vendor/sdk/workbasehq-mcp-0.2.15.tgz"
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
WORKBASE_BUILD_SHA=<40-character-commit-sha> bun run build:console
```

Schema planning writes `schema.lock.json` and `migrations/0001_r1.sql`; access
auditing needs that lock and writes `access.lock.json` and `access.lock.md`.
OpenAPI follows and stamps revision and `x-workbase-config-hash`.
Commit these artifacts with `package-lock.json`. `check` runs schema, access,
OpenAPI and UI checks. `typecheck` generates UI first; the console build generates
the Vite assets and build metadata. Generated UI lives under ignored
`.workbase-ui*`; assets live under `dist/`. For later physical schema changes use
`bun run migrate:plan --base <git-ref>` and review generated diffs. Sources:
[template scripts](../../packages/mcp/templates/standalone/package.json),
[artifact/build assertions](../../scripts/smoke-template.ts).

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
EMAIL_FROM=login@example.test
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

After building the console, start the consumer's installed Wrangler:

```sh
WRANGLER_SEND_METRICS=false node node_modules/wrangler/bin/wrangler.js dev \
  --local --ip 127.0.0.1 --port 9290 --inspector-port 0 \
  --persist-to .wrangler/state --log-level error
```

Open `http://127.0.0.1:9290` for same-origin console and API requests. Vite's dev
server has no API proxy. The smoke chooses a free port, waits for `/health`, then
signs in through `/auth/sign-in/magic-link`, reads the resulting URL from local
`email_outbox.body` and verifies it. It completes `/me/profile`, creates an
organization for admin membership, then invites and accepts a staff account
through the supported APIs. There are no identity SQL seeds or role selector.
Sources: [live sessions](../../scripts/lib/installed-consumer-live.ts),
[runtime composition](../../packages/mcp/templates/standalone/runtime.ts).

For manual local sign-in, request the magic link in the console, then read its URL
in a second terminal from the same D1 binding and open the matching URL:

```sh
WRANGLER_SEND_METRICS=false node --import tsx --input-type=module <<'JS'
import { getPlatformProxy } from 'wrangler'
const proxy = await getPlatformProxy({ configPath: './wrangler.jsonc',
  persist: { path: '.wrangler/state/v3' }, remoteBindings: false })
try {
  console.log((await proxy.env.DB.prepare(
    'SELECT recipient,body FROM email_outbox ORDER BY rowid DESC LIMIT 1'
  ).first()))
} finally { await proxy.dispose() }
JS
```

Treat outbox links as credentials. The automated harness explicitly forwards the
real Secure cookies for Playwright API calls over HTTP loopback; this is not an
HTTPS cookie-enforcement test. Source:
[session helper](../../scripts/lib/installed-consumer-live.ts).

## What the installed-consumer smoke checks

`bun scripts/smoke-template.ts --directory dist-sdk` uses the same initialized,
tarball-installed consumer throughout. Its unpacked fixture adds cs translations
and a nullable text field; the shipped template remains English-only. Beyond
generation/build/migrations, it checks persistence across Worker restart, CRUD,
omitted versus null PATCH, stale-write 409, 26-row paging and display-field search,
cross-org denial, and loss of staff row access after unlink. Sixteen renders cover
four routes × 1280/390 widths × cs/en with translated headings, no horizontal
overflow or page errors. Protected account fields stay out of new/edit forms;
routes/fields match the manifest, generated route tree, lock and OpenAPI. It checks
data-only MCP configuration and absence of archive/versions directories.
Sources: [smoke](../../scripts/smoke-template.ts),
[live assertions](../../scripts/lib/installed-consumer-live.ts).

Post-install commands in steps 1–7 run under OS network isolation with JS guards;
bootstrap, installation, init and npm ci do not. Live steps 8–9 run outside that
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
typecheck, cold/warm builds and live assertions with OS/Node/Bun metadata; no
performance thresholds are enforced. Source:
[evidence and timing](../../scripts/lib/installed-consumer-live.ts).

## Known gaps

- No real Cloudflare D1, queues or email-delivery proof: local D1 and outbox links
  supply the local acceptance path.
- No HTTPS `__Host-` cookie enforcement or edge CSP proof; loopback HTTP and
  built-script checks do not establish those properties.
- No `sst deploy`: the smoke bundles/imports SST configuration and checks an
  offline provision plan without registering resources.
- Legacy endpoints still mounted: `/schema`, `/console-info`, bootstrap and
  console-model routes remain. Browser request avoidance is the substitute for
  deferred retirement, not proof of 404s.

Sources: [smoke scope](../../scripts/smoke-template.ts),
[local live implementation](../../scripts/lib/installed-consumer-live.ts),
[mounted routes](../../packages/core/src/app.ts). Registry installation, config-writer
removal, seeded-role/reset automation and preview/cleanup automation remain deferred;
see [CHANGELOG](../../CHANGELOG.md) and the [phase-2 checklist](phase-2-checklist.md).
