# Generic browser console

The public browser build consumes the authenticated version 1
[console-model contract](console-model.md). An instance ID or entity is never a
build input. The registry, CRUD validators, commands, workflows and capabilities
come from the running instance. Unknown identifiers have readable fallback labels.
Only generic EN/CS interface copy and shared role labels ship in the assets.

Organization routes load public `/console-info` (instance ID, display name, roles
and default language), `/me`, `/build.json` and `/o/:org/console-model` in parallel
with the profile gate. The browser no longer requests the broad `/schema`,
`/bootstrap` or standalone `/console-registry` documents. Public branding contains
no field definitions, enum values, defaults, domain hints or records.

The organization model is held only in the session QueryClient. Focus, a 30-second
refresh, capability changes and refused writes refresh it. Changed authority
resets the old model before fetching its replacement; a failed contract read hides
old content. Query keys include organization and live capabilities. Switching
organizations uses a separate projection and localization resource store; logout
clears the QueryClient. The instance revision is not used as a permission cache.
No browser metadata grants authority: every request still uses existing server
policies, field masks, CSRF and concurrency checks.

The adapter overlays only the sanitized registry within the same contract. It
keeps separate create/update validators, including write-only inputs, and hides
technical fields in ordinary detail rendering while retaining them in authorized
read projections. Generic edit actions require readable `version` metadata.
Instances without a console provider get authorized entity navigation; custom
widgets need the console provider and its live page endpoint.

`packages/console-generated/src` now contains reusable rendering code and types.
Its historical name is producer-internal, not another published npm package.
All instances use the runtime browser path; transaction commands use the generic
command form. Custom domain grammar/copy requires runtime-supported localization
or a future instance-owned extension. Missing copy falls back to identifiers;
the browser never restores it from private catalogs.

`console:build` refuses private application/fixture modules in the Rollup graph and
runs `scripts/check-console-public.ts` over every emitted file. The scan rejects
owner instance IDs, known customer names and private locale keys.  Vendor component source and its
license/notice headers remain unchanged.

The prebuilt generic assets ship inside `@workbasehq/plugins`. Node deployment
code resolves them without a browser build or TypeScript loader:

```ts
import { consoleAssetsDir } from '@workbasehq/plugins/console/assets'

const assetsDir = consoleAssetsDir() // absolute installed-package path
// W32 SST provisioner: provision({ ...applicationOptions, assetsDir })
```

This Node-only subpath stays separate from the console plugin/contract and Worker
runtime imports. It resolves the installed package even when deployment code is
bundled into `.sst/platform`. W32's `assetsDir` accepts the result directly.
Consumers install only plugins and its matching core peer; UI, console-generated,
frontend-console, Vite and a source checkout are unnecessary. There is no install
hook or consumer compilation.

Producer `prepack` rebuilds the frontend producer workspace and stages
`console/assets` in plugins. `bash scripts/sdk-pack.sh` uses the same staging step
and strips producer scripts/development dependencies from registry-safe manifests.
The payload contains `index.html`, hashed JS/CSS, generic EN/CS locale JSON,
`build-meta.json`, Apache `LICENSE` and the shared-component `NOTICE`.
Metadata reads `version` from the plugins manifest; no private package version is
used. Producer workspaces, fixtures and private catalogs are excluded. Build and
staged/packed scans reject private content and source maps; only the exact
reviewed component NOTICE can contain its provenance attribution.

Run the outside-checkout npm tarball acceptance check with:

```sh
bun scripts/smoke-console-package.ts
```

It rebuilds, stages and `npm pack`s core/plugins, scans extracted assets, verifies
all export targets and exclusions, installs with an isolated npm cache under
`/tmp`, and runs plain Node and an SST-style bundled resolver check. Installation
disables lifecycle scripts to prove the assets need no compilation. Candidate
tarball integrity and a lockfile digest are printed; temporary files are removed.
The package versions remain at the current SDK version until release preparation.

The focused local browser proof is:

```sh
bun run console:build
bunx playwright test --config packages/frontend-console/playwright.runtime.config.ts
```

It starts an isolated `127.0.0.1` Worker and D1 database with `acme_neutral` (kernel
IDs use underscores), exercises real CRUD/dashboard/audit, adds another entity
and table at runtime, and revokes permissions at the same revision on refocus.
It checks unchanged asset hashes, response/DOM canaries, CSP and axe; its teardown
stops the Worker. The screenshot is `/tmp/workbase-runtime/neutral-console.png`.
The test-only control routes live solely in this local Worker fixture.
