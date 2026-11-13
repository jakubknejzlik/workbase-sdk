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
