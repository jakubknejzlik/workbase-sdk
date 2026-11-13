# Console UI data and build adapters

`@workbasehq/plugins/console/ui` is a browser-safe data contract. Import entity
**types** directly from `schema/<entity>`; never import config or entity values
into UI sources. For example:

```ts
import type worker from '../../schema/worker'
import { entityDetailPage, layout } from '@workbasehq/plugins/console/ui'
export default entityDetailPage<typeof worker>('worker', {
  title: 'worker.detail', recordParam: 'workerId',
  layout: layout<typeof worker>(['name']),
})
```

The file `ui/workers/$workerId/index.ts` determines the path. Detail/edit helpers
require `recordParam`. Links use `link('worker', 'detail')`, normalized to a path
and explicit parameter bindings; `buildPath` rejects missing and extra params.
Slot prop specifications and parameter/binding declarations are data.

The `/check` entry validates sources before evaluation and normalizes a strictly
validated, deterministic manifest. Only function-valued page/slot `component`
properties are stripped. The manifest and generated route tree belong in an
ignored generated directory, never in source control.

Allowed `ui/**/*.ts` top-level code runs at the same trust as `vite.config.ts`.
This is not a sandbox. Unresolved or unclassified imports are rejected. Browser
components live in `-` directories; only custom pages and slot registries import
them. They are replaced with functions only in the extraction server.

- No React renderer, fetching, cache or store (slice 8).
- No dictionaries, key existence, bare-text lint, or placed/omit completeness and span checks as CI validators (slice 9). Titles are only checked to be key-shaped.
- No `/me`, capabilities, hiding, action registry or access card (slice 12). `action` nodes are rejected.
- No auth shell or boot (slice 13).
- No `query()` grammar, MCP AST editing, `access.lock` consumption, legacy `frontend-console` changes or packaging proof (slice 18).
- Wrappers render a placeholder `RouteView`.

Use `consoleUI()` from `/vite` in the Instance's Vite plugins. It loads config
through `loadConfig`, checks the entire UI import graph, then evaluates only UI
sources with extraction-only component stubs. Install the optional peers `vite`,
`@tanstack/router-generator`, `es-module-lexer` and `typescript`; the generated
application also needs `@tanstack/react-router` and React.

Import `routeTree` from `./.workbase-ui/routeTree.gen`. The adapter generates
wrappers with a placeholder `RouteView`, retaining definitions in route static
data for the later renderer. Add `.workbase-ui*` to the Instance's `.gitignore`.
The directory is an atomic symlink to a completed generation; regeneration
failures retain the last good tree and send Vite's error overlay. Successful
regeneration invalidates modules and sends a full reload. The plugin exposes
`idle()`, `generation` (manifest, hash and paths), and `error` for tooling/tests.
An unused new schema file triggers regeneration without changing the manifest
hash; it is never imported or evaluated by extraction.

Manifest v2 includes field type/editability metadata for entities referenced by
pages. `/client` exports the framework-free `createClient` and pure `diff` body
builder. Create one client per injected `{actorId, orgId}`; replace it on scope
change. Pass an `AbortSignal` to each request. `client.list(entity, metadata)`
creates a forward-only cursor session: `load({search, sort, dir}, signal)` resets
it and `more(signal)` advances it. Queries always use a root limit of 25.
Entity `/api/` validation errors include only issue paths and codes; existing
profile error envelopes remain unchanged. Writes use same-origin cookies, JSON, per-draft idempotency keys and quoted
versions; browsers supply Origin/Sec-Fetch-Site. Never inject Bearer credentials.

Known gap: the server validator still accepts whitespace-only names. The generic
form builder trims strings and blocks empty required values; this slice does not
change global validation. Browser/Worker restart means persisted D1 data;
drafts are intentionally not persisted.
