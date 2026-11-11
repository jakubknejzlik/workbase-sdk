# Row invitation follow-up proof

Base: merged SDK PR #10 (`3c53f91`). Part of jakubknejzlik/workbase#176.

The follow-up derives expiry from existing invitation timestamps, renews expired
invitations through authorized resend, adds a server-side access-state filter and
a protected copy-link action, and restricts member navigation. No migration,
dependency, lockfile or package-version change is required.

## Proof

Raw local logs are under `/tmp/codex/176-proof` in the implementation workspace.
Commands below were actually executed; blocked checks are not counted as passing.
The final toolchain uses Node 25.8.0 and Bun 1.4.3, matching SDK CI. The first shell
had Node 22.23.4 and Bun 1.4.4. Full-suite retries use
`NODE_OPTIONS=--max-old-space-size=16384`.

| Command | Exit | Key output |
| --- | --- | --- |
| `bun install --frozen-lockfile` (Bun 1.4.3) | 0 | `9 packages installed [54.00ms]` |
| `bun run lint` | 0 | `SDK source whitespace lint passed` |
| `bun run typecheck` | 0 | `tsc --noEmit && tsc --noEmit -p packages/ui && tsc --noEmit -p packages/frontend-console` |
| `bun x vitest run packages/plugins/members/test/row-invitations.test.ts packages/plugins/members/test/p8-management.test.ts` | 0 | `Test Files 2 passed (2)`; `Tests 62 passed (62)` |
| `bun run --cwd packages/frontend-console test` | 0 | `Test Files 1 passed (1)`; `Tests 12 passed (12)` |
| `bun run check:ci-invariants` | 1 | `private terms not provided / incomplete; set WORKBASE_PRIVATE_TERMS` |
| `bash scripts/sdk-pack.sh` | 1 | Same missing private-term scan input |
| `bun scripts/check-sdk-boundary.ts` | 1 | Same missing private-term scan input |
| `bun scripts/scan-sdk-public.ts` | 1 | Same missing private-term scan input |
| `gitleaks detect --source . --no-banner --redact --ignore-gitleaks-allow --exit-code 1 --log-opts=--all` | 0 | `23 commits scanned`; `no leaks found` |

Full `bun run test` / `bun run test:mcp` results are recorded below when complete.
Their first attempts were interrupted with exit 130 after the old expiry assertion
failed / Node's default heap exhausted. The obsolete assertion that expired
invitations cannot resend was updated to the requested renewal behavior; accepted
and revoked invitations remain unavailable. The targeted suite above passes.

Red evidence: the original backend run reported `3 failed | 24 passed`, including
missing expired state and unsupported access filter (the navigation fixture then
needed Console installed). The console run reported `2 failed | 5 passed`: missing
expired label and missing copy-link button. Final focused runs are green as above.
Copy-link denial and positive constrained-token behavior already existed at the
HTTP boundary and remain covered; the new tests exercise each documented exact
minimum allowlist, including missing-operation refusals.

Chromium command (local browser override):

```sh
PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome \
bun x playwright test -c packages/frontend-console/playwright.row-invitations.config.ts
```

Three attempts: exit 1 (fixture display-field setup), exit 0 (`1 passed (8.1s)`),
exit 1 (Czech label absent after a direct Vite rebuild removed copied locales).
The passing run exercised actual clipboard contents, 410 expired acceptance,
filter persistence across reload, resend, recipient acceptance, own-row reads and
member navigation. Subsequent visual changes move access controls from the narrow
Actions column into a dedicated column and detail card. **The final layout and
added mobile assertion remain browser-unverified.** No fourth attempt was made.
The normal `bun run console:build` prepares locale assets but is blocked by the
same absent private-term input; direct Vite builds succeeded independently.

## Risks and named coverage

| Risk | Named test |
| --- | --- |
| Expired credential granting access or resend retaining an old credential | `176b expired token is refused; expired row can resend a fresh seven-day token and accept` |
| Superseded invitation history resurfacing or renewing | `176b cancelled replacement never resurrects expired row history; superseded resend refuses` |
| Filtering only the current page or reusing a cursor with another state | `176b access filters select live invited and signed-in rows and bind cursors to the filter` |
| Credential disclosure to a non-inviter | `176b copy-link denies non-inviter %s without rotating or disclosing token`; `176b status-only token sees state but no invitation details or management actions` |
| Member administration/navigation disclosure | `176b member navigation contains only policy-readable entities and no settings or admin pages` |
| Incomplete delegated token examples or weakened operation gates | `176b documented minimum constrained token succeeds for %s`; `176b constrained invite denies missing %s` |
| Final column/card layout and mobile behavior | `176b Czech console filters expired invitations, copies, resends and restricts accepted member navigation` — final browser run unverified |
| Packaging and public-export verification | `SDK CI` job: `check:ci-invariants`, `sdk-pack.sh`, boundary and public scans — blocked by missing scan input |
