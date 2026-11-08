# Standalone SDK getting started

A standalone instance installs only the public core, plugins and mcp SDK packages,
plus ordinary deployment/development tools. The prebuilt generic console ships in
plugins; infra and the workbase-migrate command ship in core. No producer checkout
or browser build is needed. Use Bun 1.4.3 and Node 22.13+.

After the matching release is available on npm:

```sh
bunx @workbasehq/mcp init --root /absolute/path/to/instance --id neutral_instance --target cloudflare-github
cd /absolute/path/to/instance
git init
bun install
bunx --no-install sst install
bun run migrate:initial
bun run typecheck
bun run check:migrations
```

The CLI is available as `workbase` and `workbase-mcp`. Init pins all three SDK
packages to its own release version. It writes files only and preserves conflicts. Review its JSON report.
The generated README.md is the complete local and remote operator guide; CLAUDE.md
contains the branch/MCP/PR workflow. The canonical template lives in
[packages/mcp/templates/standalone](../../packages/mcp/templates/standalone/).

A new instance has entities: {}, permissions: {}, policies: {}. Run initial SQL
once before the configuration MCP loop. Keep config, history, SQL and the lockfile
in git. Never regenerate an existing migration chain or hand-edit generated schema.
Use inspect → propose → validate → preview → apply_to_disposable → promote for
schema changes; give each new entity explicit permissions and policies.

For local development, copy .dev.vars.example to .dev.vars, generate a stable
private secret with `openssl rand -hex 32`, run migrate:local then migrate:plugins,
and start `bun run dev` on 127.0.0.1. When EMAIL is absent, retrieve the magic link from local D1 email_outbox.body
as shown in the generated README. Stop the Worker before migrating local persistence.

The generated .mcp.json registers separate config and data processes from the
installed package. Config uses the instance root; data uses WORKBASE_BASE_URL,
WORKBASE_TOKEN and WORKBASE_ORG_ID. Obtain an organization-scoped agent token from
the authenticated owner's session; never commit it. Restart config MCP after install
and initial SQL. The data server defaults to read-only.

Remote deployment uses the thin sst.config.ts and
`@workbasehq/core/infra/provision`, with `consoleAssetsDir()` from
`@workbasehq/plugins/console/assets`. Install the pinned tools from package.json
and run `sst install` to generate provider types before typechecking. The provisioner
runs packaged workbase-migrate for SQL/plugin verification before upload, and
supplies SCHEMA_EXPECTED plus D1/KV/queues/DLQ/cron/ASSETS bindings. Wrangler is local
only. See the [infra contract](../../packages/core/src/infra/README.md).

Copy deploy.env.example to private .env and fill the account/token, stable
BETTER_AUTH_SECRET, WORKBASE_RESOURCE_PREFIX, exact HTTPS AUTH_BASE_URL,
EMAIL_FROM authorized for Cloudflare send_email, and optional WORKBASE_DOMAIN
matching that origin. URL/domain may contain `{stage}`. WORKBASE_OWNER_EMAIL is
the address used manually at login, not a seeded owner or authorization grant.
Registration is open; the creator becomes organization owner. Review that policy
before opening the instance to public traffic. Configure a verified recipient
where required by Cloudflare's delivery setup.

SST Cloudflare home uses the account-level shared `sst-state` R2 bucket. Resolve
account access and state sharing explicitly before `bun run deploy --stage trial`.
A resource/stage prefix does not isolate that bucket. Keep app/prefix/stage/secret
stable across redeploys. Production retains/protects resources. Remove disposable
stages with `bun run remove --stage trial` after acceptance.

Instance deployment workflows are excluded from this SDK checkout. Configure and review automation separately before remote use. Init preserves existing files and performs no remote actions.

Remote acceptance must cover schema compatibility, console HTML/assets under CSP,
HTTPS magic-link delivery, organization creation, permitted and denied writes,
redeploy/data retention, queue/cron and stage removal. Health alone is insufficient.
Release staging/publication and real-account acceptance are separate operator gates;
local packed-package smoke (`bun scripts/smoke-mcp-template.ts`) verifies generated
files and installed candidate bytes without deployment.

## Upgrade existing configs to 0.2.3

Pin `@workbasehq/core`, `@workbasehq/plugins` and `@workbasehq/mcp` to `0.2.3`,
install, and restart the config MCP. Configs from 0.2.1/0.2.2 that lack a valid
`displayField` can now be inspected and repaired. No config changes happen at
startup. The Worker remains strict: repair the config before starting/deploying it.

1. Call `inspect_schema({"instance":"your-instance"})` to find the revision.
   Call `validate({"instance":"your-instance"})` to receive every display-field
   error. Each error includes a `suggestedChange`; review these suggestions.
2. Submit all repairs together to `propose_change`, using that revision as
   `baseRevision`. For an existing entity the exact operation is:

   ```json
   {"kind":"set_display_field","entity":"zakaznik","displayField":"jmeno"}
   ```

   `displayField` must be an existing readable scalar field. References (`ref`)
   and fields hidden from readers are rejected. Use fields returned by inspection;
   the example identifiers above are placeholders for your own schema.
3. Call `validate({"proposalId":"..."})`, then `preview_migration` with the same
   proposal ID. Display-field-only repairs generate revision/SDK metadata SQL
   with no table changes. The original schema and record data stay intact.
4. Call `apply_to_disposable`, then `promote` with the proposal ID and the original
   revision as `expectedRevision`. Promotion writes a new config/history entry
   and migration for review. Apply the committed migration through your normal
   migration/deployment workflow before restarting the Worker.

An incomplete repair returns the remaining errors. Invalid proposals cannot be
applied or promoted. Original migrations and history are preserved; a historical
config with invalid display fields is visible in `list_versions` with rollback
blocked. Repair it in a new version rather than rewriting archived source.

## Submit a promoted change for review

After verification and `promote`, call `submit_change` with `instance`, `proposalId`
and the expected remote base commit as `expectedBaseSha`. It opens one GitHub PR
containing the promoted files, a Czech change summary and the migration preview SQL.
Retries return the same PR and immutable head SHA; preview/check status can be
`pending`. A stale base or changed promoted files are rejected.

This requires operator-configured GitHub access. The credential connection is not
available yet; the default configuration returns a Czech “GitHub access is not
configured” error. Credentials, repository, base branch and file selection are never
tool inputs. `submit_change` never merges, tags, releases or deploys.
