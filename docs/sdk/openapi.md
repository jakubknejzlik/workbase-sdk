# Committed OpenAPI

The build-time generator produces an OpenAPI 3.1 JSON document from the loaded
schema, composed command/workflow registries and the existing source config hash.
The CLI is exported as `@workbasehq/core/openapi/cli`:

```ts
import { runOpenApiCli } from '@workbasehq/core/openapi/cli'
process.exitCode = await runOpenApiCli(process.argv.slice(2))
```

Use `--write` to regenerate. Without it, missing or different bytes fail the check
without writing anything. `--config`, `--root` and `--directory` follow the access
CLI conventions. By default `openapi.json` sits beside the Instance's `config.ts`.
The SDK root's `openapi:write` and `check:openapi` scripts target `worker-access`.

The CLI uses the existing literal `loadConfig` boundary and composes a kernel
from that loaded config. The pure `generate(config, kernel, configHash)` function
also accepts an already composed registry, including registered Instance commands
and workflows. Loading executable Instance registration modules is subject to the
existing loader's restrictions; this slice does not extend that loader or its hash.
The literal worker fixture mirrors the programmatic runtime fixture's schema and
access policy, with a test requiring identical generated documents.

Objects use the access lock's canonical serializer. Set-like declaration arrays
are sorted without locale-dependent comparison; authored enum order is retained.
The query extension reuses the current public schema projection verbatim. Request
schemas use Zod's input mode so transforms describe their accepted HTTP input.
The existing `/schema` projection and its output-mode behavior stay unchanged.

REST list cursors contain the last returned row id. Query cursors are opaque
signed tokens bound to the query and authorization scope. Optional response fields
allow field masks and query selections; strict row objects reject undeclared keys.
The document publishes field names and safe metadata, including masked fields,
while omitting row filters, predicate names, expression bodies, defaults, credentials
and deployment configuration. Allowed entity operations are boolean `true` even
when runtime access is filtered. Action reasons are public dictionary keys.

Generic command results have no registered output schema and remain opaque.
Built-in access action results describe credential property names as strings;
no token or URL value is included. JSON Schema cannot express every runtime
semantic check (authorization, cursor verification, query cost and uniqueness).

This slice only generates and checks the artifact. Runtime serving, binding the
committed JSON into a Worker, live hash verification and changes to build metadata
belong to the subsequent serving slice. The document reserves its own public path.
