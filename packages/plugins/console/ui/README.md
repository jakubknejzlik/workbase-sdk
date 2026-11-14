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
<Session orgId={orgId} t={t} baseURL="">
  <RouterProvider router={router} />
</Session>
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
- No MCP translation operations, `CustomTypeOptions` typing, ICU, nested keys or contexts.
- No languages beyond cs/en, no date/number formatting helpers, no visual/axe checks.
- No list-column completeness and no `frontend-console` changes.

The V3 standalone template wires this validator through its `check:ui` script.

`/i18n` uses the optional `i18next` ([configuration](https://www.i18next.com/overview/configuration-options)) and React peers.
Import bundled resources from `.workbase-ui/locales.json`, then call
`initI18n({ languages, profile, catalogs })` once during host startup. It returns
`{ t, languages, language, changeLanguage, subscribe }`; authored TSX imports
`{ t }` directly from `@workbasehq/plugins/console/ui/i18n`. `createI18n` creates
an independent runtime for tests or isolated hosts. Pass the returned runtime's
`t` and the runtime as `i18n` to
`ConsoleProvider` for live copy updates, and render `LanguageSwitcher` from
`/react` with `{ i18n }`. It appears only for multiple configured languages.
`resolveLanguage(profile, languages)` uses a configured profile language or the
first configured language. Neither detection nor browser/profile storage occurs.

The named `t` is for React rendering and reads the consuming `ConsoleProvider`'s
translator; it has no global translator fallback. Use the returned runtime's
`i18n.t` for event handlers and non-React callers. Async SSR work outside the React
render tree must carry its own runtime; request isolation there is out of scope.

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

The `Session` shell boots `/me` and live capabilities in parallel. Only a ready
session mounts its children, including `Shell` and the router. Failed boot offers
retry; unauthenticated and removed membership states show a generic message.
`Shell` takes the built manifest, hides unauthorized nav targets, and supplies an
accessible mobile disclosure. Parameterized nav targets require its `params`.

The pure `gate(caps, manifest)` is shared by routes, navigation and fields.
Missing grants deny. `ConsoleProvider` is available for custom hosts, which must
supply `caps` and handle `onAuthorizationFailure`; omitting caps grants no data
access in the renderer. Session drops to loading on a data 403, refetches on tab
visibility, and replaces the client, query cache and drafts whenever canonical
`[actorId, orgId, caps]` changes. No capability data persists outside that scope.
Slots receive only declared authorized props and `t`. Action nodes consume only
the owning detail's `actions` entries, and use `ui:actions.<name>` labels.

Register the SDK access card in `ui/-slots.ts` with an explicit dependency on the
account-link field. The extractor stubs this exact SDK component import; it does
not admit other React exports into data modules.

```ts
import { defineSlots, p } from '@workbasehq/plugins/console/ui'
import { AccessCard } from '@workbasehq/plugins/console/ui/react'
export default defineSlots({
  accessCard: {
    contexts: ['record'],
    props: { account: p.field('userLink'), access: p.access() },
    component: AccessCard,
  },
})
```

Place `slot('accessCard', { account: 'user' })` in the detail layout (`user` is the
Instance's account-link field). `p.access()` is implicit; authored values and form
or row placement fail validation. The renderer passes projected state/actions,
a bound `run()` using `actWith()`, and a lazy `candidates()` only with the
`members.read` grant. The card receives no entity, ID, client or identity. A masked
field omits the whole slot, and absent access state renders nothing.

Invitation links appear only from the mutation result, in component state until
unmount. They never enter either detail cache or GET state. Unlinking removes the
record/account link and leaves organization membership intact. SDK reasons use
`access.*`; other action reasons use the Instance's `ui:` namespace.

The full pack gate runs `test/browser/acceptance.test.ts` against local Worker/D1
and Chromium, including cookie sessions and the 390px interaction matrix. The
SDK CI and release workflows install the lockfile-pinned Chromium version first.


Mount `AuthShell` from `@workbasehq/plugins/console/ui/react` outside the
Instance `RouterProvider`. Create its runtime once with
`createAuthI18n({ languages, catalogs })`; this feeds `workbase:language` from
localStorage through the existing profile-language seam. Pass `{ manifest, i18n,
navigate: path => router.navigate({ to: path }) }` and the router as children.
The shell intercepts `/sign-in`, `/auth/complete`, and `/invitation` before
mounting the Instance router. Those first route segments are reserved.

Sign-in requests always use `/auth/complete`. The validated return destination
is consumed once from `sessionStorage['workbase.returnTo']`; only built manifest
routes and `/invitation?id=…` are accepted. Tokens are scrubbed with
`history.replaceState` immediately and retained only in the mounted invitation
component. Refreshing a token page discards the token; use the original link or
sign in and open the invitations inbox. All invitation requests use JSON POST
bodies and no referrer. `consoleUI()` injects the no-referrer HTML meta tag;
existing Worker responses also set the header on the SPA and invitation redirect.
The initial incoming link necessarily transports its token in the document URL;
no subsequent request URL, history entry, storage or console output retains it.

Slice-11 copy links carry **no mailbox proof**. On staging without an EMAIL
binding, the recipient clicks Continue and submits the inline magic-link form.
An operator reads that second link directly from D1, using the query shape in
`scripts/identity-session.mjs`:

```sql
SELECT body FROM email_outbox
WHERE recipient=? AND subject='Workbase sign-in'
ORDER BY rowid DESC LIMIT 1;
```

Bind the recipient email. Open the returned link in that recipient's browser
within **10 minutes**. There is no outbox HTTP endpoint. The callback consumes a
safe destination, or uses the recipient inbox when there are no memberships.
Account mismatch screens reveal no invited email and offer a sign-out button.
The server remains the authority for resolving and accepting an invitation.

`localStorage['workbase:org']` stores the selected org only. One membership is
selected automatically, several offer a chooser, and none show the invitation
inbox. `Session` still validates membership and boots exactly `/me` and
capabilities in parallel; its optional `onState(kind)` reports existing states.
An unauthenticated state returns to sign-in; removal clears the org and offers
selection again. Identity and capability caches remain owned by `Session`.

The profile gate renders in place after a ready session, keyed by actor, or
before invitation acceptance. Only `completeness.complete` releases it. Names
owned by an IdP produce terminal copy with sign-out. A profile GET failure leaves
the normal app shell usable; invitation acceptance remains gated with retry.
PATCH failures retain the form, and each submit sends at most one PATCH.
Sign-out POSTs JSON, accepts 204/401, clears the org, and replaces the location
with `/sign-in`. Language persists across accounts on the same browser by design;
no identity or profile data is stored alongside either preference.

`consoleUI()` production builds define `__WORKBASE_BUILD_SHA__` in the browser
bundle and emit `dist/build-meta.json` with `{ sha, builtAt }`. SHA precedence is
`WORKBASE_BUILD_SHA`, then `GITHUB_SHA`, then `git rev-parse HEAD` from the
**consumer root**. A supplied invalid value fails the build instead of silently
falling back. SHAs must be exactly 40 hex characters and are emitted lowercase.
Development builds use `unbuilt`. The V3 template's `bun run build:console` runs
`bun --bun vite build`; then pass
`assetsDir: './dist'` to provision (or match a customized Vite outDir). These are
the Instance's assets; do not use the legacy `consoleAssetsDir()`.

The Instance deployment wrapper must refuse a dirty repository before building:

```ts
import { assertCleanDeploy } from '@workbasehq/plugins/console/ui/vite'
assertCleanDeploy(process.cwd())
// Run vite build, then provision/deploy the resulting dist/.
```

The guard includes untracked files. Ignore `node_modules/`, `dist/` and
`.workbase-ui*`; commit authored layout changes before deployment so they get a
new SHA even when schema revision is unchanged. The V3 template checks/builds
before SST deployment but does not call this optional guard in its deploy script
or Vite config; ensure the worktree is clean before deploying. Keep any explicit
server BUILD_SHA/BUILD_AT bindings consistent with the emitted metadata.

`AuthShell` fetches `/build.json` separately at boot and on visibility. On a valid
SHA mismatch it records `sessionStorage['workbase.reload.' + serverSHA]` **before**
reloading. The latch survives remounts and stays set for that tab's session, so a
persistent mismatch reloads once. `unbuilt` and other non-hex values cannot
trigger reload. Metadata failures leave the app usable. Disabled storage skips
a reload because a persistent latch cannot be guaranteed.

SDK record forms, sign-in and profile-gate forms register dirty state with their
owning shell. Reload waits until all registrations are clean or unmounted.
Custom forms can call the additive `useAuthDirty(dirty)` export from `/react`.
No draft values enter the reload watcher or browser storage. The latch is public
build state, independent of accounts and orgs.

On `pagehide` (including sign-out) the shell synchronously unmounts every private
view so the back/forward cache never stores account data. Unmounting a dirty form
during that teardown does **not** release a deferred reload: the departing
document is not reloaded, so the user's navigation completes and the destination
document loads the new build. A `persisted` `pageshow` re-boots the shell and then
releases a still-pending reload for the restored document. Compatibility note:
because the restored document re-boots from fresh `/me` and capabilities, unsaved
in-memory form drafts do not survive leaving the document and returning with
Back/Forward (as with reload or tab close). Navigation and session caches
retain their existing scope and recovery behavior.

The `console/ui/react` and `console/ui/vite` source subpaths are included by the
plugins package file list and producer staging, including the UI README. The
staged-tarball regression verifies the actual React/Vite exports. The standard `bash scripts/sdk-pack.sh` gate also
requires the private vocabulary input; a missing secret prevents a release
archive from being certified. The built HTML probe rejects inline script/style
and verifies the no-referrer meta tag. Browser acceptance records every flow and
fails if it requests console-model, console-info, bootstrap or `/schema`.
