# @workbasehq/core/infra

SST Cloudflare provisioning, migration and schema tooling for Node deployment
scripts, isolated from core's Worker runtime entry. The public SDK remains three
packages: core, plugins, mcp. SST and Pulumi are optional peers used only by the
provisioner; migrations and dry plans need only the optional `tsx` loader at runtime.
Migration-only imports from `@workbasehq/core/infra` also typecheck without deployment
peers. The deployment API lives in `@workbasehq/core/infra/provision`.

## SST provisioner

```ts
provision(options: ProvisionOptions): Promise<ProvisionResult>
createProvisionPlan(options: ProvisionOptions): Promise<ProvisionPlan>
```

Install the tested deployment tools explicitly (Node 22+, TypeScript 5.7+):

```sh
npm install @workbasehq/core
npm install -D sst@4.17.1 tsx@4.23.15
```

Use Cloudflare provider `6.19.0` in `sst.config.ts`. SST's pinned Pulumi version
supports TypeScript <6; the packed consumer check uses TypeScript 5.7.2.
With all three SDK packages installed, mcp supplies `tsx` transitively, so only
`sst` is needed as an additional deployment dependency. Do not install Pulumi or
the command provider for provisioning: resources and secrets use SST's injected
globals, and migrations use the command provider resolved from `$cli.paths.platform`.
SST 4.17.1 supplies command 1.0.1 and Pulumi 3.215.0 there. The provisioner verifies
that command resolves the same Pulumi module as the platform before loading it;
it does not force a separate command provider version. Optional Pulumi peers are
only for consumers that need their types directly.

```ts
/// <reference path="./.sst/platform/config.d.ts" />
export default $config({
  app(input) {
    return {
      name: 'neutral-instance', home: 'cloudflare',
      providers: { cloudflare: '6.19.0' },
      removal: input.stage === 'production' ? 'retain' : 'remove',
      protect: input.stage === 'production',
    }
  },
  async run() {
    const { provision } = await import('@workbasehq/core/infra/provision')
    const deployed = await provision({
      configPath: './config.ts', handler: './worker.ts', migrationsDir: './migrations',
      resourcePrefix: 'neutral-instance', stage: $app.stage,
      authSecret: new sst.Secret('AuthSecret').value,
      authBaseUrl: process.env.AUTH_BASE_URL!,
    })
    return { url: deployed.url, databaseId: deployed.databaseId }
  },
})
```

The operator supplies `CLOUDFLARE_DEFAULT_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`,
`AUTH_BASE_URL` and a stable SST `AuthSecret` before deployment. The auth secret
must be at least 32 characters; retain it across redeployments. `authBaseUrl` is
the exact public HTTPS origin, without credentials, query, fragment or a path.
Use the known workers.dev origin or supply `domain` with the same hostname.
The API does not discover the account subdomain or generate an auth secret.

| Input | Contract |
| --- | --- |
| `configPath`, `handler`, `migrationsDir` | Required application-owned module, Worker entry and ordered SQL directory |
| `resourcePrefix`, `stage` | Required lowercase DNS-style names; prefix ≤63, stage ≤32 characters |
| `authSecret`, `authBaseUrl` | Required stable `Input<string>` secret and explicit HTTPS origin |
| `assetsDir?` | Existing prebuilt console directory; absent means no `ASSETS` binding |
| `domain?` | Optional Cloudflare custom hostname matching the auth origin |
| `email?: { from }` | Native `EMAIL` send binding restricted to this sender, plus `EMAIL_FROM` |
| `webhook?: { url, allowedHosts, service?, events? }` | Explicit URL/host allowlist, optional existing Worker service name and event filter |
| `internalToken?` | Optional secret `INTERNAL_TOKEN` for protected operations |
| `opsToken?` | Optional secret `OPS_TOKEN` for protected operations; takes precedence over `INTERNAL_TOKEN` |
| `accountId?`, `projectRoot?` | Override account environment value or path root; SST normally runs in the app root |
| `protect?` | Protect/retain primary resources; defaults to true for `production` |
| `migrationTriggers?` | Extra fingerprints for imported application/plugin verification code |

Protected `/internal/*` endpoints keep the `X-Internal-Token` header. Set
`opsToken` (or the runtime `OPS_TOKEN` binding) to use a dedicated operations
secret. Once `OPS_TOKEN` is set, only its value is accepted; the legacy
`INTERNAL_TOKEN` value is rejected with 403. Without `OPS_TOKEN`, `INTERNAL_TOKEN`
continues to work unchanged. With neither configured, these endpoints return 503.
Both provisioning options may be supplied during transition; `/internal/ops`
reports only boolean presence flags for these bindings.

Config modules are trusted application code. Relative paths resolve from
`projectRoot`, defaulting to `process.cwd()` (the app root inside SST). Secrets
accept Pulumi Outputs/SST secret values and are marked secret in Pulumi state.
No secret or webhook destination is included in the dry plan. `ProvisionDiagnostic`
and `provisionErrorMessage()` expose fixed branded codes, never arbitrary exception
text or input values.

The graph creates D1 `DB`, KV `AUDIT_KV`, `EVENTS_QUEUE`, a DLQ, a consumer on the
same Worker and the relay cron `*/5 * * * *`. Assets run through the Worker first,
with native HTML/not-found handling disabled, so the runtime controls auth/CSP and
SPA fallback. The caller's handler must export fetch, queue and scheduled handlers
composed with its instance config. This API does not build console assets or create
a webhook receiver/landing Worker. All physical names and Pulumi logical names
include the prefix/stage identity; long names retain a deterministic tuple hash.
Worker names fit SST's 54-character workers.dev limit; other names fit 63 characters.

The packaged `workbase-migrate` entry runs SDK, plugin and domain migrations/verification
before the Worker component **and** the underlying script upload. Inputs travel
through quoted environment variables; credentials are inherited by the subprocess.
SQL-chain hash, expected schema, package sources and config source fingerprint the
migration command; use `migrationTriggers` when imported application verifier code
changes independently. The migration command is unprotected so trigger changes can
replace it, while production D1 and other primary resources remain protected.
New `defineConfig` Instances (the normalized `languages` contract) apply
`workbase-sdk` first, installed plugin namespaces next, then `migrations/`.
The SDK and plugins share `_plugin_migrations`, including append-only names,
positions, SQL checksums and retained uninstall receipts. Each file's SQL and
receipt commit in one D1 batch; a failed SDK/plugin file stops before domain SQL.
Verification, including plugin `checkSchema`, runs after the domain ledger.
A retry with no pending work executes only reads. SDK-only changes add SDK
receipts without changing the Instance revision or domain migration files.

The SDK baseline owns system/auth/workflow/operational tables, `instance_meta`
and the `users` account projection before any plugin or domain FK uses them.
Its SQL is independent of application roles and other Instance configuration;
the runtime validates roles. New-era `initialSchema(config)` emits domain DDL
and a domain revision insert only. Use `workbase-migrate ... --config ...` to
orchestrate all namespaces; applying domain SQL alone cannot bootstrap an Instance.

Existing tables or receipts without the new SDK baseline, or a legacy
`workbase-core` receipt, produce `migration_unsupported_history` with the found
tables/namespaces and an explicit unsupported/reset explanation. Preflight is
read-only: history is never copied, adopted or rewritten. A failed first SDK
file can leave an empty `_plugin_migrations` table and can be retried. The inline
`defineInstance` path retains its previous mixed baseline and deploy behavior
while its consumers are retired; it cannot serve as new-era migration history.

The Worker receives the corresponding `SCHEMA_EXPECTED`.
Migration failure blocks upload. A stable prefix/stage reuses resource addresses
and receipts; changing either creates a separate instance.

`ProvisionResult` contains URL/ID/name Outputs and resource handles for further
composition. Return only selected Outputs from SST `run()`. `createProvisionPlan`
evaluates the trusted config and local files without registering resources,
executing migration commands, contacting Cloudflare or requiring SST/Pulumi.

### Account state and operational prerequisites

SST 4.17.1 Cloudflare home uses the shared account-level R2 `sst-state` bucket
([pinned implementation](https://github.com/sst/sst/blob/v4.17.1/pkg/project/provider/cloudflare.go)).
Arrange account/state access and any required exception before deploying. Resource
prefixes isolate application resources; they do not isolate this state bucket.
This provisioner does not change SST state storage.

Email requires an authorized Cloudflare sender. With magic-link login, configure
working email delivery or another supported transport even on workers.dev. Omitting
`email` does not provide a substitute login transport. Omitting `assetsDir` leaves
the API available while the runtime reports `console_not_built` for the console.

Offline tests verify the graph, dependency ordering and installed package bytes.
Actual deploy, login, redeploy/data retention, queue/cron delivery and stage removal
require a separately authorized account-level acceptance run.

## Remote migrations

Install core and its optional CLI loader, with Node 22+:

```sh
npm install @workbasehq/core tsx@4.23.15
export CLOUDFLARE_DEFAULT_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=...
workbase-migrate migrate <databaseId> ./migrations --config ./config.ts
```

The trusted config module must default-export an `InstanceConfig` and can import
public core/plugin packages and the application's own plugins. Relative input
paths resolve from the caller's working directory. The CLI resolves the TypeScript
loader relative to the installed package. There is no instance registry or config
discovery. Worker consumers can omit the optional `tsx` peer.

Omit `--config` for a plain SQL database. With a config, migration verifies the SQL
ledger and instance revision, applies plugin migrations, and verifies their ledger
and schema hooks. SQL must already contain the matching `instance_meta` revision.
An existing SDK stamp must be a numeric release in the running SDK's major and
no newer than that SDK. Unsupported stamps fail with
`migration_instance_revision_mismatch` before any SQL or plugin migrations or
ledger writes; the version is checked again after SQL and before plugin execution.
After verification, a stale core version is refreshed on that revision's row,
including releases with no pending SQL or plugin migrations. Older revision rows
and migration receipts are preserved; rerunning with the current version writes
no marker. A failure before the refresh can leave the old stamp; retry the deploy
to resume verification and refresh it before Worker upload.

Files must be contiguous `0001_name.sql`, `0002_name.sql`, etc. Each SQL file and
its receipt execute in one D1 HTTP transaction. Changed or missing historical SQL,
retroactive insertion and changed plugin receipts fail closed. An unchanged chain
can be reapplied without changing existing receipts. The CLI preserves the
`infra.migrations.applied` JSON event and suppresses arbitrary transport/config/
plugin error text to avoid exposing credentials or application data.

## API

Migration helpers are exported from `@workbasehq/core/infra`:

| Exports | Purpose |
| --- | --- |
| `migrateD1`, `Migration`, `D1Query`, `QueryResult` | SQL migration ledger |
| `httpD1Query` | HTTP adapter (optional fetch adapter for tests) |
| `migrateInstance`, `queryDatabase` | Instance/plugin migration verification |
| `readMigrationFiles`, `migrationHash`, `sha256` | File loading and hashing |
| `expectedSchema`, `ExpectedSchemaOptions` | Expected schema bindings |
| `runCli`, `migrationErrorMessage` | CLI helpers |

Deployment helpers are exported from `@workbasehq/core/infra/provision`:

| Exports | Purpose |
| --- | --- |
| `provision`, `ProvisionOptions`, `ProvisionResult` | Explicit-input SST Cloudflare resource graph |
| `createProvisionPlan`, `ProvisionPlan`, `validateProvisionOptions` | Offline input validation and secret-free dry mapping |
| `ProvisionDiagnostic`, `provisionErrorMessage` | Safe typed provisioning diagnostics |

```ts
import { expectedSchema } from '@workbasehq/core/infra'
import config from './config'

const schema = await expectedSchema({
  migrationsDirectory: './migrations', revision: config.revision, config,
})
// Supply JSON.stringify(schema) as the Worker's SCHEMA_EXPECTED binding.
```

For non-Workbase databases, omit `config` and pass an explicit `coreVersion` if
needed. This subpath supplies no owner domains or hosted integration defaults.

Tests live in `packages/core/test/infra` and use `vitest.infra.config.ts`. The packed
CLI test runs `npm pack` on staged core bytes, installs the tarball outside the repo,
and exercises D1 HTTP against transactional SQLite through a fetch fixture. It
also typechecks a migration-only consumer before installing deployment peers,
imports and dry-plans provisioning without SST/Pulumi, typechecks a consumer
`provision()` call, runs the emitted migration command and executes an SST-style
bundle from the consumer's `.sst/platform` directory.

`bash scripts/sdk-pack.sh && bun run test:sdk-sst` installs the three packed SDK
packages plus SST in a clean directory and runs real `sst diff` previews with
local state, dummy credentials and Cloudflare API URLs pointed at loopback. It
checks every resource (including the Worker/custom domain/migration/consumer/cron)
and verifies that loaded Pulumi/command modules belong to SST's platform, then
repeats with conflicting consumer Pulumi/command dependencies installed. CI `check`
runs this regression alongside `test:infra`.
