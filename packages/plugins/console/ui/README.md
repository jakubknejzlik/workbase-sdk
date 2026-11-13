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

- No `/me`, capabilities, hiding, action registry or access card (slice 12). `action` nodes are rejected.
- No auth shell or boot (slice 13).
- No `query()` grammar, MCP AST editing, `access.lock` consumption, legacy `frontend-console` changes or packaging proof (slice 18).

Use `consoleUI()` from `/vite` in the Instance's Vite plugins. It loads config
through `loadConfig`, checks the entire UI import graph, then evaluates only UI
sources with extraction-only component stubs. Install the optional peers `vite`,
`@tanstack/router-generator`, `es-module-lexer` and `typescript`; the generated
application also needs `@tanstack/react-router` and React.

Import `routeTree` from `./.workbase-ui/routeTree.gen`. The adapter generates
wrappers with the real `/react` `RouteView`, metadata and declared route bindings. Add `.workbase-ui*` to the Instance's `.gitignore`.
The directory is an atomic symlink to a completed generation; regeneration
failures retain the last good tree and send Vite's error overlay. Successful
regeneration invalidates modules and sends a full reload. The plugin exposes
`idle()`, `generation` (manifest, hash and paths), and `error` for tooling/tests.
An unused new schema file triggers regeneration without changing the manifest
hash; it is never imported or evaluated by extraction.

Manifest v3 includes field type/editability metadata for entities referenced by
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

The `/react` entry exports `ConsoleProvider`, `RouteView`, `PageView`, `useRecord`,
`useList`, and the recursive `renderNode`. The host injects identity and `t`:

```tsx
<ConsoleProvider identity={{ actorId, orgId }} t={t} baseURL="">
  <RouterProvider router={router} />
</ConsoleProvider>
```

Use the generated route tree with TanStack Router. `PageView` also accepts an
injected navigation callback for hosts without generated routes. Slot registries
remain real browser components; wrappers import `ui/-slots.ts` and pass only
slot-declared field values. Titles go through `t` and the shared dictionary validator. Optional peers are React, TanStack React Router and React Query. Data always
comes from HTTP, backed by the Worker/D1 API; the runtime ships no memory store.

Forms send only changed, placed, editable fields. Save uses the declared detail
binding (or list when detail is absent). Cancel returns to detail from edit and
list from create; dirty cancellation and router back ask for confirmation.
Version conflicts retain the draft until **Reload server copy** is explicitly
chosen. That action replaces the draft; subsequent saves diff against the fresh
version. Editable refs and unknown field types show an explicit unsupported
error. There is no picker or ref-label lookup.

Local acceptance: `bunx vitest run --config
packages/plugins/console/ui/vitest.config.ts` covers renderer states and browser
history in jsdom; `bunx vitest run packages/core/test/console-client.test.ts`
executes the same client against the real Worker and native D1 with a synthetic
optional field, including persisted values read by a fresh Worker/client.

Manifest v3 carries `omit`, `col(node, span)` and finite `defineKeys` families from
`ui/keys.ts`. Columns are direct row children. Responsive spans inherit through
xs/sm/md/lg/xl with xs defaulting to 12. A row must total at most 12 at each
breakpoint; all-12 rows stack. Mixed rows do not reset their sum at full-width cells.
Detail pages place or omit every field; forms cover editable fields. Slot field
props count as placement; protected account links require slots or omission.

`validateInstance(root)` from `/check` collects sorted findings. Run the same
validator with `bun run check:ui [root]` (the root script defaults to the committed
four-page cs/en fixture). Domain keys are `entity.<entity>` (plural),
`field.<entity>.<field>` and `enum.<entity>.<field>.<value>`. The SDK-injected users
projection is SDK-owned, outside authored domain inventory. UI titles, key props,
TSX translation calls and finite dynamic families construct the UI inventory.
Dictionary keys cannot create requirements themselves. Every configured locale
must provide the required keys, plural forms and matching interpolation variables.

Non-goals:
- No action nodes or reason keys (slice 10).
- No `/me`, profile storage, capability hiding or access card (slice 12).
- No auth shell or switcher persistence (slice 13).
- No template or Instance script wiring (slice 16).
- No MCP translation operations, `CustomTypeOptions` typing, ICU, nested keys or contexts.
- No languages beyond cs/en, no date/number formatting helpers, no visual/axe checks.
- No list-column completeness and no `frontend-console` changes.

`/i18n` uses only the optional `i18next` peer ([configuration](https://www.i18next.com/overview/configuration-options)).
Import bundled resources from `.workbase-ui/locales.json`, then call
`initI18n({ languages, profile, catalogs })` once during host startup. It returns
`{ t, languages, language, changeLanguage, subscribe }`; authored TSX imports
`{ t }` directly from `@workbasehq/plugins/console/ui/i18n`. `createI18n` creates
an independent runtime for tests or isolated hosts. Pass `t` and `i18n` to
`ConsoleProvider` for live copy updates, and render `LanguageSwitcher` from
`/react` with `{ i18n }`. It appears only for multiple configured languages.
`resolveLanguage(profile, languages)` uses a configured profile language or the
first configured language. Neither detection nor browser/profile storage occurs.

Namespaces are `domain`, `ui` (the default), and `sdk`, with flat dotted keys.
`fallbackLng: false` prevents language fallback; missing keys render `⟦ns:key⟧`
and log an error. Interpolation values are escaped by React. Entity labels take
`{ count }`; plural forms must match each language's `Intl.PluralRules` categories.
SDK cs/en catalogs ship in `src/locales`; optional partial
`locales/<lang>/sdk.json` overrides merge into the generated resources. Unknown
SDK keys, extra interpolation variables and `$t(` nesting fail validation.

The AST text lint scans only admitted `.tsx` files. It rejects letter-containing
JSX text, string/template children (including `&&`, `||`, `?:`) and literal
`title`, `alt`, `placeholder`, `label`, `aria-label`, `aria-description`,
`aria-placeholder`, `aria-roledescription`, and `aria-valuetext` attributes.
Translation calls must resolve to the SDK's named `t` import; aliases work,
shadowed imports fail. There are no disable comments.

Not covered: text via variables or helpers, other prop names, `.ts` files,
`confirm`/`alert`/`document.title`, CSS content, third-party components, record content.
This guards accidental bare text in authored files; it is not a sandbox.
