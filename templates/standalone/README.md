# Standalone V3 Instance guide

The single template source is [inside @workbasehq/mcp](../../packages/mcp/templates/standalone/).
Use the installed SDK CLI to copy it:

```sh
workbase init --root <dir> --id <id> --target cloudflare-github
```

Follow the [getting-started guide](../../docs/sdk/getting-started.md) for the
three coordinated tarball dependencies and identical overrides, installation,
and environment setup. The generated manifest keeps exact SDK registry pins;
use the documented tarball rewrite until that coordinated version is published.

Author `config.ts`, `schema/*`, `access.ts`, `ui/*` and `locales/en/*.json` as code.
`runtime.ts` composes plugins outside the literal config boundary. In the Instance
directory, generate artifacts in this order:

```sh
bun run migrate:plan --init
bun run access:lock --write
bun run openapi:write
bun run check
bun run typecheck
WORKBASE_BUILD_SHA=<40-character-commit-sha> bun run build:console
```

Commit the schema lock, `migrations/0001_r1.sql`, access locks, `openapi.json`
and lockfile. After configuring deployment and installing SST providers, run
`bun run deploy --stage <stage>`; it checks, builds `dist/` and runs SST with
`configPath: './runtime.ts'` and `assetsDir: './dist'`. SDK `provision()` applies
SDK, plugin and Instance migrations before upload. Init only copies files,
preserves existing bytes and reports `created`, `unchanged` or `conflict`.

The template registers data MCP only. V3 reference authoring uses the code and
CLI flow above. Managers later use the approved MCP/PR process and do not edit
code directly. See the [generated README](../../packages/mcp/templates/standalone/README.md)
for local development and repeated-init conflicts.
