# Standalone V3 Instance getting started

The standalone template builds an Instance-owned Vite console and a Worker from
three coordinated SDK packages: core, plugins and mcp. Use Bun 1.4.3 and Node
25.8.0. The canonical template and its operator guide live in
[packages/mcp/templates/standalone](../../packages/mcp/templates/standalone/).

## Init and install

Use the installed `workbase` CLI (`workbase-mcp` is an alias):

```sh
workbase init --root <dir> --id <id> --target cloudflare-github
```

Before a coordinated SDK version is published, install its three candidate
archives in a separate tools directory to obtain that CLI. Use the dependency
and override form below there too, with paths relative to the tools manifest.
Run `npm install` and put that directory's `node_modules/.bin` on your PATH.
Init only copies files and reports JSON with `created`, `unchanged` or `conflict`;
it performs no installation, generation or deployment and preserves existing bytes.

Init pins all three SDK dependencies to its own exact version. For an unpublished
candidate, copy the three matching archives into the Instance's `vendor/sdk/` and
replace only the SDK dependency entries. Add identical overrides at the manifest
root. Replace `<version>` with the coordinated version in the archive names:

```json
{
  "dependencies": {
    "@workbasehq/core": "file:vendor/sdk/workbasehq-core-<version>.tgz",
    "@workbasehq/plugins": "file:vendor/sdk/workbasehq-plugins-<version>.tgz",
    "@workbasehq/mcp": "file:vendor/sdk/workbasehq-mcp-<version>.tgz"
  },
  "overrides": {
    "@workbasehq/core": "file:vendor/sdk/workbasehq-core-<version>.tgz",
    "@workbasehq/plugins": "file:vendor/sdk/workbasehq-plugins-<version>.tgz",
    "@workbasehq/mcp": "file:vendor/sdk/workbasehq-mcp-<version>.tgz"
  }
}
```

Keep the generated React, TanStack, i18next, Vite, router-generator, lexer and
other third-party dependencies. Use file archives rather than workspace links,
directory links or TypeScript path aliases. In the generated Instance directory,
run `npm install`, commit `package-lock.json`, then use `npm ci` for frozen installs.
Registry installation of this candidate is deferred until its publication.

## Author and generate

The scaffold has one `worker` entity, admin/staff access, English dictionaries,
and list, new, detail and edit pages. Author literal configuration in `config.ts`,
entities in `schema/*`, access rules in `access.ts`, pages/navigation in `ui/*`
and translations in `locales/en/*.json`. `runtime.ts` composes plugins and enables
interactive login outside the literal loader boundary. Keep the generated
OpenAPI document out of `config.ts` imports.

Run these commands in order for a fresh Instance:

```sh
bun run migrate:plan --init
bun run access:lock --write
bun run openapi:write
bun run check
bun run typecheck
WORKBASE_BUILD_SHA=<40-character-commit-sha> bun run build:console
```

The schema planner writes `schema.lock.json` and `migrations/0001_r1.sql` first.
Access auditing executes `runtime.ts`, so it needs that lock; `access:lock` already
includes `--write` and accepts the explicit flag too. OpenAPI generation follows
and stamps revision and configHash. Commit those files with `access.lock.json`,
`access.lock.md`, `openapi.json` and the install lockfile. Init ships none of these
artifacts and never overwrites them.

`check` runs `check:schema`, `check:access`, `check:openapi` and `check:ui` in that
order. UI validation includes dictionary completeness and bare-text checks.
`typecheck` runs `generate:ui` before TypeScript. `build:console` runs Vite under
Bun with the SDK `consoleUI()` integration; the SPA mounts AuthShell. The ignored
outputs are `.workbase-ui/`, `dist/` and `.sst/`.

Replace the build SHA placeholder with the reviewed commit's 40 hex characters.
An explicit SHA is required outside git. Build from a clean, committed tree so
the SHA identifies the authored bytes; the template does not invoke the SDK's
optional `assertCleanDeploy()` guard automatically.
For later physical schema changes use `bun run migrate:plan --base <git-ref>`.
`bun run check:schema` works without git; `bun run check:schema --base <git-ref>`
also checks migration linkage. Regenerate derived artifacts after authored changes
and review their diffs rather than hand-editing generated files.

Repeated init leaves matching files unchanged. Rewriting SDK dependencies or
editing `schema/worker.ts` produces conflicts for those files with bytes intact.
It also preserves generated artifacts and the lockfile.

## Develop and deploy

Copy `.dev.vars.example` to private `.dev.vars` and configure credentials.
`bun run dev` serves the console, and `bun run dev:worker` starts local Wrangler.
There are no seeded accounts. Plain Wrangler domain migrations alone do not
initialize the SDK/plugin tables; use the SDK migration orchestration for a
complete database. The template supplies `bun run migrate:remote` for a configured
remote `DATABASE_ID`, using `runtime.ts`.

For deployment, copy `deploy.env.example` to private `.env`. Configure
`CLOUDFLARE_DEFAULT_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, stable `BETTER_AUTH_SECRET`,
`WORKBASE_RESOURCE_PREFIX`, exact HTTPS `AUTH_BASE_URL`, and an authorized
`EMAIL_FROM`. Optional `WORKBASE_DOMAIN` must match that origin. URL/domain may
contain `{stage}`. `WORKBASE_OWNER_EMAIL` is a manual login address, not a seed
or authorization grant. Registration is enabled and the creator becomes organization
owner; review that policy before opening the Instance to public traffic.

Run `bun x --no-install sst install` to fetch providers and generate provider types; this step needs
network access. Commit authored files and generated artifacts before deployment.
Then run:

```sh
bun run deploy --stage <stage>
```

The deploy script checks, builds `dist/`, then runs SST. Its thin `sst.config.ts`
passes `configPath: './runtime.ts'` and `assetsDir: './dist'` to SDK `provision()`.
Provisioning applies SDK → plugin → Instance migrations before upload. See the
[infra contract](../../packages/core/src/infra/README.md) for state, bindings and
migration guarantees. In staging, native Worker requests redirect to the canonical
`AUTH_BASE_URL`; that origin must be reachable and must not redirect to itself.

SST uses the account-level shared `sst-state` R2 bucket. Arrange account/state
access before deployment; resource/stage prefixes do not isolate that bucket.
Keep app/prefix/stage/secret stable across redeploys. Production retains/protects
resources. Remove disposable stages with `bun run remove --stage <stage>` after
acceptance. Live deployment and remote acceptance require the operator's account.
No preview workflow or deployment wrapper is included in this template.

The generated `.mcp.json` registers only data MCP, using `WORKBASE_BASE_URL`,
`WORKBASE_TOKEN` and `WORKBASE_ORG_ID`, with read-only mode by default. Keep
credentials private. Legacy config-writer proposal/promotion and schema discovery
are not the V3 authoring flow. Managers operating the Instance later use the
approved MCP/PR process and do not edit code directly.

Remote acceptance covers schema compatibility, console assets under CSP, HTTPS
login, organization creation, permitted and denied writes, redeploy/data retention,
queue/cron and stage removal. The SDK pack gate's V3 template smoke verifies
installed candidate bytes and the local generation/check/build/migration path;
it does not deploy or prove remote acceptance.
