# Standalone V3 Instance getting started

The standalone template serves the prebuilt SDK console and a Worker from
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
interactive login outside the literal loader boundary. `config.ts` binds the generated
`openapi.json` for anonymous serving; the literal loader can generate it before it exists.

Run these commands in order for a fresh Instance:

```sh
bun run migrate:plan --init
bun run openapi:write
bun run access:lock --write
bun run check
bun run typecheck
```

The schema planner writes `schema.lock.json` and `migrations/0001_r1.sql` first.
OpenAPI generation follows and stamps revision and configHash. Access auditing
executes `runtime.ts`, so it needs both generated artifacts; `access:lock` already
includes `--write` and accepts the explicit flag too. Commit those files with `access.lock.json`,
`access.lock.md`, `openapi.json` and the install lockfile. Init ships none of these
artifacts and never overwrites them.

`check` runs `check:schema`, `check:access`, `check:openapi` and `check:ui` in that
order. UI validation includes dictionary completeness and bare-text checks.
`typecheck` runs `generate:ui` before TypeScript. Vite remains a development
dependency for this authoring check. The served console comes prebuilt from
`@workbasehq/plugins`, with SDK layout, CSS, cs/en and magic-link sign-in;
Instance `ui/*` sources are validated but are not bundled into that console.
The shipped `.gitignore` uses `.workbase-ui*` to ignore both the `.workbase-ui` symlink and
its `.workbase-ui.generation-*/` sibling directories; `dist/` and `.sst/` are also
ignored. Existing Instances must replace `.workbase-ui/` with `.workbase-ui*`
before generating or staging files.

For later physical schema changes use `bun run migrate:plan --base <git-ref>`.
`bun run check:schema` works without git; `bun run check:schema --base <git-ref>`
also checks migration linkage. Regenerate derived artifacts after authored changes
and review their diffs rather than hand-editing generated files.

Repeated init leaves matching files unchanged. Rewriting SDK dependencies or
editing `schema/worker.ts` produces conflicts for those files with bytes intact.
It also preserves generated artifacts and the lockfile.

## Develop and deploy

Copy `.dev.vars.example` to private `.dev.vars` and configure credentials.
`bun run dev` (or `bun run dev:worker`) starts the Worker at
`http://127.0.0.1:9290`, serving assets directly from
`node_modules/@workbasehq/plugins/console/assets` alongside the API.
No console build or `WORKBASE_BUILD_SHA` is needed. Unauthenticated `/me`
returns JSON 401. A fresh, unconfigured Worker returns 503 for magic-link
sign-in. The template supplies no complete local database/auth bootstrap flow;
use a configured deployed origin for end-to-end login acceptance.

There are no seeded accounts. Plain Wrangler domain migrations alone do not
initialize the SDK/plugin tables; use the SDK migration orchestration for a
complete database. The template supplies `bun run migrate:remote` for a configured
remote `DATABASE_ID`, using `runtime.ts`.

For deployment, copy `deploy.env.example` to private `.env`. Configure
`CLOUDFLARE_DEFAULT_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, stable `BETTER_AUTH_SECRET`,
`WORKBASE_RESOURCE_PREFIX`, exact HTTPS `AUTH_BASE_URL`, and an authorized
`EMAIL_FROM` (or a dev/test mailbox token), plus `WORKBASE_OPS_TOKEN`.
Optional `WORKBASE_DOMAIN` must match that origin. URL/domain may
contain `{stage}`. `WORKBASE_OWNER_EMAIL` is a manual login address, not a seed
or authorization grant. Registration is open for first sign-in; self-service
organization creation is disabled. Follow [first-owner onboarding](onboarding.md)
to sign in, provision through ops and invite staff without real mail on dev/test.

Run `bun x --no-install sst install` to fetch providers and generate provider types; this step needs
network access. Commit authored files and generated artifacts before deployment.
Then run:

```sh
bun run deploy --stage <stage>
```

The deploy script checks, then runs SST. Its thin `sst.config.ts` passes
`configPath: './runtime.ts'` and `assetsDir: consoleAssetsDir()` from
`@workbasehq/plugins/console/assets` to SDK `provision()`. The provisioner sets
`htmlHandling: 'none'`, `notFoundHandling: 'none'` and `runWorkerFirst: true`
so the Worker handles SPA fallback and auth/API routes.
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

The generated `.mcp.json` registers `workbase_config` for local V3 authoring,
plus separate data and ops MCP servers with environment-only credentials. Data
uses `WORKBASE_TOKEN` and `WORKBASE_ORG_ID`, with read-only mode by default; ops
uses `WORKBASE_OPS_TOKEN` and optional mailbox inputs. Both remote servers use
`WORKBASE_BASE_URL`, for example `https://app.example.test`. Mailbox variables have
empty defaults so they can be omitted in production. See [onboarding](onboarding.md)
and keep credentials private.

## V3 changes through MCP

After installation and initial artifact generation, start `workbase_config` from
the Instance directory. It runs `workbase config --root .` without API credentials
or optional environment variables. Existing Instances must merge this entry from
the template manually because init never overwrites `.mcp.json`.

Use `inspect_schema` with the Instance selector, then `propose_composition` with
`instance`, the inspected `baseRevision`, and `changes`. Use `set_plugin` to add a
built-in plugin or replace its options (including plugin `console` to enable the
console), and `set_interactive` to set interactive login. Access authoring uses
`set_system_access` for a role's system grants, `set_entity_access` for a role's
entity access, and `set_account_link` for an entity's invitation role. Composition
and access kinds can share a proposal; `propose_change` also accepts these kinds.
Keep legacy changes separate.

Continue with `validate` → `preview_migration` → `apply_to_disposable` → `promote`.
Pass the returned `proposalId` each time; `promote` also takes `expectedRevision`
from inspection. Review validation requirements and previewed sources, access locks
and plugin SQL before disposable verification. Input or dependency changes require
validation and verification again. Promotion writes local sources, regenerated
access locks and, for access edits, an existing OpenAPI artifact. It preserves the
domain revision and migration history and does not deploy or apply to a live DB.
Managers use this approved MCP/PR process and do not edit code directly. Review
and commit promoted files, then deploy through the normal SDK migration engine.

V3 domain-change promotion is unsupported (`v3_promote_unsupported`). Physical
schema changes require reviewed source edits and migration generation. Custom
plugins/commands, plugin removal and role definitions also require reviewed source
changes. See [composition and access inputs](mcp-composition.md).

Remote acceptance covers schema compatibility, console assets under CSP, HTTPS
login, organization creation, permitted and denied writes, redeploy/data retention,
queue/cron and stage removal. The SDK pack gate's V3 template smoke verifies
installed candidate bytes and the local generation/check/prebuilt-assets/migration path;
it does not deploy or prove remote acceptance.
