# List v2 — approved pattern

Use this pattern for the shared generated list page. Reuse follows the
[SDK UI definition of done](../sdk-ui-definition-of-done.md): no new owner approval
is needed, but independent visual review of each UI PR is still required.

## Approved reference and acceptance

- Reference package: `workers-approved-sdk-reference.zip`.
- Reference SHA-256: `f95b87d93e814b41f1d8856b1063b9bb1b23237cb9147a2145dd7194e167a2f0`.
- [Owner approval, 2026-11-19](https://github.com/jakubknejzlik/workbase-sdk/issues/222#issuecomment-6994976097).
- [#232 — shared page composition and reference package contents](https://github.com/jakubknejzlik/workbase-sdk/issues/232).
  The package includes the proposal, reference specification, interactive HTML
  and desktop/mobile, expanded-filter and access-menu screenshots. Reference
  assets remain outside the repository.
- [#233 — independent re-acceptance: ACCEPT](https://github.com/jakubknejzlik/workbase-sdk/issues/233#issuecomment-7018768570)
  on `a51c635eb84cf4e4bd128f28f4704e226fdf6e55`: 18 captures at 1440/390 reviewed
  against the approved reference; 34 functional checks passed. This is the
  recorded historical verdict, not acceptance of a later candidate SHA.
- Supporting [capture harness](../acceptance/list-v2-harness.md) and
  [review rubric](../acceptance/list-v2-rubric.md). Captures and functional checks
  alone do not issue a visual verdict.

## Page and menu rules

- One shared list composition contains tabs, toolbar, expanded filter panel,
  applied-filter chips, table and footer. The footer uses server-authoritative
  totals and numbered pages for the offset list; tab counts are exact, never
  estimated from the loaded rows.
- Toolbar filters apply immediately. Panel filters are a draft with explicit
  Apply/Cancel; Cancel discards only that draft. Chips, rows, counts, URL and
  saved-view state derive from confirmed settings.
- Personal saved views use a compact named-view menu inside the list toolbar.
  Show contextual Save only when confirmed saved settings differ from the
  applied view (or the initial baseline when none is applied), with a modified
  indicator. Search, pagination and draft-panel changes do not mark D7 modified.
- Selecting a personal view only stages a candidate. Applying it is explicit;
  selection, reload and catalogue refresh never auto-apply it. The selected
  candidate and applied view remain separate.
- Save as new stays reachable in the menu, including with an empty catalogue.
  Rename/Delete manage the applied view inside the menu, with named delete
  confirmation. Updating the current view is a save-dialog choice, never an
  update to a merely selected candidate. Do not restore the permanent five-button
  row.
- Explain browser-local storage contextually in the saved-view menu and
  save/rename dialog, rather than as a permanent toolbar sentence. Preserve form
  input and list settings on storage failures.
- The separate display menu controls column visibility and compact density.
  Honor configured defaults and keep the primary record column visible. Hiding
  a column changes presentation, not permissions, selected fields, filters, sort
  or counts; it does not extend D7 saved views.
- Keep the compact row-access dot/value/chevron before generic Actions, with
  state wording in its menu/tooltip. “Signed in” means a linked account, not a
  live session. Preserve invitation behavior and permission checks.
- Menus, dialogs and toolbar controls must remain reachable at 390 px, including
  long names and reduced permissions; review the whole page in EN/CS at 1440/390.

## D7 storage and authority rules

Personal views retain browser `localStorage` v1, scoped by **verified instance,
user, organization and entity**. Store only allowlisted filters, sort/direction,
configured preset ID and row-access selection. Keep existing limits and
revalidate stored settings against current capabilities before explicit Apply;
reset paging on Apply and report dropped settings. Free-text search, pagination,
page size, calendar presentation/date, column visibility and density are outside
D7. Guard stale callbacks and discard old list state/data on actor or org change.

Explicit sign-out clears that account's saved views across organizations and
entities; ordinary 401/session-expiry redirects do not. Storage failure must not
block logout. See the existing [saved-view storage contract](../../../packages/plugins/console/ui/README.md)
for verified-scope and cleanup integration.

## Separate remaining work

- [#165 — V3 ListView wiring](https://github.com/jakubknejzlik/workbase-sdk/issues/165)
  remains separate. Generated-console delivery does not implement the V3 adapter;
  that work must reuse this approved menu and retain its adapter acceptance
  requirements.

## Display-preference storage

[#236 Q2](https://github.com/jakubknejzlik/workbase-sdk/issues/236#issuecomment-6995234699)
uses generated-console browser `localStorage` separately from D7 and URL/query
state. The versioned `workbase:list-prefs:v1:` namespace encodes verified instance,
user, organization and entity and stores `{ visible: string[], density }`. The
authenticated host supplies the same verified scope as personal views; unknown
or mismatched scope never reads or writes a persisted namespace.

Defaults follow `columns[].defaultVisible` and configured compact density. Reset
removes the preference and restores those defaults. Stored IDs are revalidated
against the current configured, readable columns; unknown IDs are discarded and
the primary column stays visible. Presentation preferences never affect selected
fields, search, filters, sort, requests or counts. Storage failure retains choices
in memory for the current document, including list remounts.

Explicit generated-console logout clears that account's display preferences
across organizations and entities and invalidates mounted callbacks. Unknown
verified account scope clears only this feature's namespaces. Ordinary session
expiry does not clear preferences, and storage failure cannot block sign-out.
V3 wiring remains separate.
