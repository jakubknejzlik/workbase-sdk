# V3 Cleaning worker spike

Feasibility proof for [ADR #260](https://github.com/jakubknejzlik/workbase/issues/260) and the latest [#264 decision](https://github.com/jakubknejzlik/workbase/issues/264). Throwaway implementation, isolated from the existing SDK console. The only worker fields are `name` and v4 `user` (`userLink`), with the v3 `slots` relation. Slot columns project `starts_at`, `job_id`, `booked` from Cleaning.

From the repository root, using Bun 1.4.3 and Node 25.8.0:

```sh
bun install --frozen-lockfile
bun run spike:check
bun run spike:typecheck
bun run spike:test
bun run spike:manifest
bun run spike:build
bun run spike:browser
bun run --cwd examples/spike-cleaning-worker dev
```

Open `/workers`, `/workers/w1`, `/workers/new`, `/workers/w1/edit`, `/workers/w1/trasa`. The browser proof serves `dist/` with Vite preview and closes it after testing. It requires a Playwright Chromium installation (`bunx playwright install chromium` if needed). Create/edit changes live in memory until a full reload. The access slot deliberately renders disabled placeholder actions; no backend, invitation workflow or production permissions implementation is implied.

`ui/` is the authoring route directory. Every route is `.ts`, default-exporting an SDK helper. Layouts are separate data modules and can be shared. `ui/-slots.ts` declares props, field types, required context and renderers. `ui/nav.ts` controls menu order/group metadata. Instance labels use i18next JSON namespaces with fallback disabled.

The Vite plugin mirrors routes into gitignored `.ui-v3/routes/`, then uses TanStack's actual file-route generator to create `.ui-v3/routeTree.gen.ts`. Typecheck generates these files too, so it works in a clean checkout. Every entity helper returns the same branded `page()` value; the renderer and validator use that result.

Manifest extraction uses Vite's Node SSR loader with a dedicated component-stubbing plugin. It imports route `.ts` modules, schema, registry and nav, then invokes `getManifest()`. Stubs preserve exported component names by transpiling and lexing exports, never executing components or importing their dependencies. No page/layout AST extraction. CI separately uses TypeScript syntax inspection to reject prohibited imports.

Root lint/typecheck/test commands append the new slice checks to the existing commands. Existing package source, console behavior, release workflows, tags and issues are untouched. The lockfile preserves every original workspace/package entry and adds only the new ones.

See [FINDINGS.md](./FINDINGS.md) for decisions, limitations, timings and proof. Screenshots: [desktop](./artifacts/detail-desktop.png), [mobile](./artifacts/detail-mobile.png).
