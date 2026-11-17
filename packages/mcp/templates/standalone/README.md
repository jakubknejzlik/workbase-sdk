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
config boundary and enables interactive login there. `config.ts` binds the generated
`openapi.json` for anonymous serving; the literal loader can generate it before it exists.
For a fresh Instance run these in order:

```sh
bun run migrate:plan --init
bun run openapi:write
bun run access:lock --write
bun run check
bun run typecheck
bun run build:console
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
sibling directories; `dist/` and `.sst/` are also ignored.
`build:console` validates UI sources and builds the Instance's routes, browser
components and dictionaries into `dist/console`, using public SDK renderer,
auth and CSS exports. This per-Instance delivery follows ADR 0008 and supersedes
the shared prebuilt scaffold delivery from SDK #45. It needs no private workspace.
The generated `build-meta.json` identifies the emitted bundle, independently of
git, `WORKBASE_BUILD_SHA` and schema revision. Page and dictionary edits change
that SHA; `/build.json` reports the same metadata. Shared auth/CRUD dirty-state
tracking defers same-revision SHA reloads until drafts are safe to release.
V3 boot uses bundled metadata and makes no console-model, console-info,
bootstrap or schema request.

## Run and deploy

`bun run dev` (or `bun run dev:worker`) starts the local Worker at
`http://127.0.0.1:9290`. Wrangler checks and rebuilds `dist/console` through its custom build command,
then serves it with the API on the same origin. After editing UI sources, restart
Wrangler or run `bun run build:console` to rebuild the browser assets. Unauthenticated `/me` returns JSON 401.
A fresh, unconfigured magic-link sign-in returns 503; the template supplies no
complete local database/auth bootstrap flow. Use a configured deployed origin
for end-to-end login acceptance.
Apply SDK, plugin and Instance migrations with the SDK migration tool; plain
Wrangler domain migrations alone do not initialize a complete database.
There are no seeded accounts. Configure credentials privately from the env examples.

For deployment copy `deploy.env.example` to `.env`, configure the environment,
then run `bun x --no-install sst install` to fetch providers and generate SST types. This step needs
network access. `bun run deploy --stage <stage>` checks, then runs SST.
The SST config rebuilds the console before provisioning, including direct
`sst deploy` invocations. It passes `assetsDir: './dist/console'` to `provision()`, which sets
`htmlHandling: 'none'`, `notFoundHandling: 'none'` and `runWorkerFirst: true`.
The Worker handles SPA fallback and auth/API routes on the same origin.
SDK `provision()` applies SDK → plugin → Instance migrations before upload.
For staging, set `AUTH_BASE_URL` to the canonical origin: native Worker requests
redirect there, so it must be reachable and must not redirect to itself.
No deploy is performed by init. No preview workflow or deployment wrapper ships here.

## First owner without real mail

For a disposable `dev` or `test` stage, set independent `WORKBASE_OPS_TOKEN` and
`WORKBASE_DEV_MAILBOX_TOKEN` secrets in private `.env`, alongside the auth and
Cloudflare inputs. Leave `EMAIL_FROM` empty: the SST config rejects it together
with the mailbox token. Every other stage rejects the mailbox; without that
token, an authorized `EMAIL_FROM` is required. Deployment returns `devMailboxUrl`.

Export `WORKBASE_BASE_URL` (the canonical app origin), `WORKBASE_OPS_TOKEN`,
`WORKBASE_DEV_MAILBOX_URL` (that output) and `WORKBASE_DEV_MAILBOX_TOKEN` to your
MCP client. `.mcp.json` registers `workbase ops` beside the data server with
environment-only credentials; SST's `.env` is not automatically the MCP environment.

Request the owner's magic link in the browser, call
`read_dev_mail({ recipient: "owner@example.test", limit: 1 })`, open the returned
sign-in message's `body` URL and complete the profile. Then call
`provision_organization({ name: "First organization", ownerEmail: "owner@example.test" })`
and refresh the console. Invite staff through a worker's invite action and read
their sign-in/invitation links with `read_dev_mail` in a separate browser profile.
Registration stays open for that initial sign-in; `allowCreate: false` keeps org
provisioning on the protected ops route. Do not enable self-service creation as
the onboarding path. See `docs/sdk/onboarding.md` in the SDK repository for the
full flow and `docs/sdk/dev-mailbox.md` for the mailbox contract.

The ops server needs no data token or org ID. The data server separately needs
`WORKBASE_TOKEN` and `WORKBASE_ORG_ID` and defaults to read-only access. Production
uses real mail and ops provisioning with both mailbox MCP variables omitted.

Init creates missing files and reports `created`, `unchanged` or `conflict`.
It preserves existing bytes. Rewritten SDK dependencies and authored schema files
therefore report conflicts on repeated init.

For later Manager operation use the established MCP/PR process; Managers do not
edit code directly. Use the V3 authoring workflow below; legacy schema-discovery tools are not its
replacement.


## V3 authoring through MCP

After installation and initial artifact generation, start `workbase_config` from
this Instance directory. `.mcp.json` runs `workbase config --root .` through the
installed SDK; this local authoring server needs no API credentials or optional
environment variables. The existing `workbase_data` and `workbase_ops` servers
keep their separate data and provisioning responsibilities. For example, their
canonical app origin can be `https://app.example.test`; it is not needed by config.

Call `inspect_schema` with `instance: "{{INSTANCE_SELECTOR}}"`. At the returned
revision, call `propose_composition` with `instance`, `baseRevision` and `changes`.
The supported kinds are:

- `set_plugin`: add a built-in plugin or replace its options. Use plugin `console`
  to enable the console. Omitted options reset the plugin to defaults.
- `set_interactive`: set interactive login; enabling it requires a login provider.
- `set_system_access`: replace a role's system `grants` with allow/deny decisions.
- `set_entity_access`: replace `entity`/`role` access with `"deny"` or a complete
  read/create/update/delete object of allow/deny or filtered grants.
- `set_account_link`: set an entity's `invitationRole`.

Composition and access kinds can share a proposal. `propose_change` accepts the
same V3 kinds; keep them separate from legacy changes. Continue with `validate` →
`preview_migration` → `apply_to_disposable` → `promote`, passing `proposalId` at
each step and the inspected revision as `expectedRevision` to `promote`. Review
validation requirements, exact file bytes, access-lock changes and plugin SQL
before verification. After any tracked source or dependency change, validate and
verify again.

Promotion publishes local sources and regenerated access locks, plus an existing
OpenAPI artifact for access edits. The domain revision, schema lock and domain
migration history stay unchanged. Promotion does not deploy or apply to a live
database. Review and commit the promoted files through the approved PR process;
the normal SDK deployment applies plugin migrations. Use `discard` to close an
unpromoted proposal.

V3 domain-change promotion is unsupported (`v3_promote_unsupported`). Physical
schema changes require reviewed source edits and migration generation. Custom
plugins/commands, plugin removal and role definitions also require reviewed source
changes. See `docs/sdk/mcp-composition.md` in the SDK repository for inputs and
limitations.
