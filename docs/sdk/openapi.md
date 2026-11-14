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

Bind the committed artifact in the Instance's `config.ts` after binding its schema
lock: `bindOpenApi(bindSchemaLock(defineConfig({...}), lock), spec)`, with
`bindOpenApi` imported from `@workbasehq/core/schema` and `spec` from
`./openapi.json`. `createApp` serves its canonical bytes anonymously at
`GET /openapi.json`. The route helper is exported from
`@workbasehq/core/openapi/routes`. Unbound or invalid runtime data returns
503 `{ "error": "openapi_not_bound" }`; invalid bindings throw during binding.

Provisioning hashes the file beside `config.ts` into `OPENAPI_SHA256` and exposes
it as `build.json.openapi`. Consumers without the artifact report `unbuilt`.
Run `check:openapi --live <origin>` after building to compare the served bytes,
`build.json.openapi` and the committed file. This also checks local generation
drift, never writes, and exits non-zero on missing metadata or any mismatch,
including a bundle built with an older spec. `--live` and `--write` are exclusive.

The CLI uses the existing literal `loadConfig` boundary and composes a kernel
from that loaded config. The pure `generate(config, kernel, configHash)` function
also accepts an already composed registry, including registered Instance commands
and workflows. Loading executable Instance registration modules is subject to the
existing loader's restrictions. Generated-artifact wrappers are recognized without
reading the spec into the source hash; the hash algorithm is unchanged.
The literal worker fixture mirrors the programmatic runtime fixture's schema and
access policy, with a test requiring identical generated documents.

Objects use the access lock's canonical serializer. Set-like declaration arrays
are sorted without locale-dependent comparison; authored enum order is retained.
The query extension reuses the current public schema projection verbatim. Request
schemas use a default-free Zod input projection with an explicit public vocabulary
allowlist. It follows output-facing metadata across wrappers and pipelines, carries
sensitivity internally, and omits pipeline-only constraints and object keys absent
from the public output shape. Shared schemas are converted once per generation;
runtime default, prefault and catch factories are never evaluated. The existing `/schema` projection and its output-mode behavior
stay unchanged.

REST list cursors contain the last returned row id. Query cursors are opaque
signed tokens bound to the query and authorization scope. Optional response fields
allow field masks and query selections; strict row objects reject undeclared keys.
The document publishes field names and safe metadata, including masked fields,
while omitting row filters, predicate names, expression bodies, defaults, credentials
and deployment configuration. Entity permissions reuse `/schema.policies` exactly:
entity → role → `true`, without operation grants or internal tables. Field metadata
uses the same public field projection as `/schema`; protected user-link/computed
flags and action condition inventories or command associations are omitted.
Action components encode both tuple lengths, and every component insertion rejects
an existing name.

Generic command results have no registered output schema and remain opaque.
Built-in access action results describe credential property names as strings;
no token or URL value is included. JSON Schema cannot express every runtime
semantic check (authorization, cursor verification, query cost and uniqueness).

The document reserves its own public path. Swagger UI, YAML, client generation
and per-role documents are outside this contract.
