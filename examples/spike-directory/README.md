# V3 directory spike, round 2

Feasibility fixture for [#264](https://github.com/jakubknejzlik/workbase/issues/264) and [ADR #260](https://github.com/jakubknejzlik/workbase/issues/260). The SDK owns rendering, field controls, tables, relation filtering, storage and routing wrappers. Instance code supplies schema/seed data, `.ts` pages and layouts, a slot registry, custom components, dictionaries and bootstrap wiring.

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run spike:check
bun run spike:test
bun run spike:build
bun run spike:manifest
bun run spike:browser
```

Worker routes: `/workers`, `/workers/w1`, `/workers/new`, `/workers/w1/edit`, `/workers/w1/trasa`.
Job routes: `/jobs`, `/jobs/j1`, `/jobs/new`, `/jobs/j1/edit`.
`/overview` uses `page()` directly with the job list data, exercising the same renderer as the entity helpers.

`jobs` preserves the source schema's string `title`, reference `client_id`, enum `priority`, and read-only enum `status` with its default. Both entity details use responsive 8/4 columns and data-driven `related('slots', ...)`. Saves mutate an SDK-owned memory store; navigation retains data until a full reload. Access actions remain explicit disabled placeholders. The custom map imports real Leaflet.

Generated TanStack wrappers, the page catalog and route tree live in ignored `.ui-v3/`, outside `ui/`. The supported route grammar is directory segments and `$params`; unsupported TanStack naming conventions fail before extraction. Bound `defineUI` layout facades retain schema/entity typing; routes still directly call registered SDK page helpers. MCP operations are not implemented.

`spike:browser` serves the built fixture and writes screenshots and browser evidence to `../round2-artifacts/` relative to the repository root, outside Git. Generated manifest/log files are ignored. No scan guard or policy exemptions were changed. See [FINDINGS.md](./FINDINGS.md) for the exact validation output and remaining scope limits.
