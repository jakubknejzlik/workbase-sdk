# {{INSTANCE_ID}}

A V3 Instance with one worker entity and list, new, detail and edit pages.
Bun 1.4.3 and Node 25.8.0 are required. See `docs/sdk/getting-started.md` in the
SDK repository for the installation and review workflow.

Generate this scaffold with the installed SDK CLI:

```sh
workbase init --root <dir> --id <id> --target cloudflare-github
```

## Install

The package manifest pins all three SDK packages to `{{SDK_VERSION}}`.
Until that version is published, copy its three archives into `vendor/sdk/` and
replace just the SDK dependencies with the following entries. Add identical
`overrides` at the package root so transitive SDK dependencies use the same bytes:

```json
{
  "dependencies": {
    "@workbasehq/core": "file:vendor/sdk/workbasehq-core-{{SDK_VERSION}}.tgz",
    "@workbasehq/plugins": "file:vendor/sdk/workbasehq-plugins-{{SDK_VERSION}}.tgz",
    "@workbasehq/mcp": "file:vendor/sdk/workbasehq-mcp-{{SDK_VERSION}}.tgz"
  },
  "overrides": {
    "@workbasehq/core": "file:vendor/sdk/workbasehq-core-{{SDK_VERSION}}.tgz",
    "@workbasehq/plugins": "file:vendor/sdk/workbasehq-plugins-{{SDK_VERSION}}.tgz",
    "@workbasehq/mcp": "file:vendor/sdk/workbasehq-mcp-{{SDK_VERSION}}.tgz"
  }
}
```

Keep the React and other third-party dependencies from the generated manifest.
Run `npm install`, commit `package-lock.json`, then use `npm ci` for frozen installs.

## Author and generate

During phase 2, author `config.ts`, `schema/*`, `access.ts`, `ui/*` and
`locales/en/*.json` as code. `runtime.ts` composes SDK plugins outside the literal
config boundary and enables interactive login there. Do not import the generated OpenAPI document into `config.ts`.
For a fresh Instance run these in order:

```sh
bun run migrate:plan --init
bun run access:lock --write
bun run openapi:write
bun run check
bun run typecheck
WORKBASE_BUILD_SHA=<40-character-commit-sha> bun run build:console
```

Commit `schema.lock.json`, `migrations/0001_r1.sql`, `access.lock.json`,
`access.lock.md` and `openapi.json` together. They are generated for this Instance;
init never ships or overwrites them. Later schema changes use
`bun run migrate:plan --base <git-ref>`; `check:schema` works without git and can
also accept `--base <git-ref>` to check migration linkage.
`access:lock` already supplies `--write` and targets `runtime.ts`; the explicit
flag above is accepted too. `check` runs schema, access, OpenAPI and UI validation.
UI generation runs before typecheck. The shipped `.gitignore` uses `.workbase-ui*`
to ignore both the `.workbase-ui` symlink and its `.workbase-ui.generation-*/`
sibling directories; `dist/` and `.sst/` are also ignored. Existing Instances must
replace `.workbase-ui/` with `.workbase-ui*` before generating or staging files.
An explicit build SHA is required outside git. Build from a clean, committed tree
so the SHA identifies the authored bytes; the template does not automatically
invoke the SDK's optional `assertCleanDeploy()` guard.

## Run and deploy

`bun run dev` starts Vite without an API proxy. AuthShell's same-origin `/me`,
`/build.json` and `/auth/...` requests return 404 there even while `dev:worker`
runs, so login through Vite cannot work. For local asset/API inspection, build
the console as above, then run `bun run dev:worker` alone and open
`http://127.0.0.1:9290`. The Worker serves the built console and `/build.json`;
unauthenticated `/me` returns JSON 401. Rebuild after UI changes. This is not a
complete local login setup: fresh, unconfigured magic-link sign-in returns 503.
The template supplies no complete local database/auth bootstrap flow; use a
configured deployed origin for end-to-end login acceptance.
Apply SDK, plugin and Instance migrations with the SDK migration tool; plain
Wrangler domain migrations alone do not initialize a complete database.
The detail page uses the SDK application-access card and the SPA mounts AuthShell.
There are no seeded accounts. Configure credentials privately from the env examples.

For deployment copy `deploy.env.example` to `.env`, configure the environment,
then run `bun x --no-install sst install` to fetch providers and generate SST types. This step needs
network access. `bun run deploy --stage <stage>` checks, builds `dist/`, then runs
SST. SDK `provision()` applies SDK → plugin → Instance migrations before upload.
For staging, set `AUTH_BASE_URL` to the canonical origin: native Worker requests
redirect there, so it must be reachable and must not redirect to itself.
No deploy is performed by init. No preview workflow or deployment wrapper ships here.

Init creates missing files and reports `created`, `unchanged` or `conflict`.
It preserves existing bytes. Rewritten SDK dependencies and authored schema files
therefore report conflicts on repeated init.

For later Manager operation use the established MCP/PR process; Managers do not
edit code directly. This template's MCP config contains only the data server;
legacy schema-discovery tools are not the V3 authoring workflow.
