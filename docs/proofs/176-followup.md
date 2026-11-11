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
| `bun run --cwd packages/frontend-console test` | 0 | `Test Files 1 passed (1)`; `Tests 13 passed (13)` |
| `bun run --cwd packages/ui test` | 0 | `Test Files 14 passed (14)`; `Tests 97 passed (97)` |
| `bun test scripts/sdk-provenance.test.ts scripts/lib/sdk-workspaces.test.ts` | 0 | `3 pass`; `0 fail` |
| `bun run test:mcp --bail=1 --reporter=verbose` | 1 | `1 failed`; `1303 passed`; `2 skipped` — 60-second workflow-tool timeout |
| `bun run test` | 1 | Runtime: `1856 passed (1856)`; infrastructure: `85 passed (85)`; tooling: `5 failed` files / `7 failed` tests |
| `bun run check:ci-invariants` | 1 | `private terms not provided / incomplete; set WORKBASE_PRIVATE_TERMS` |
| `bash scripts/sdk-pack.sh` | 1 | Same missing private-term scan input |
| `bun scripts/check-sdk-boundary.ts` | 1 | Same missing private-term scan input |
| `bun scripts/scan-sdk-public.ts` | 1 | Same missing private-term scan input |
| `gitleaks detect --source . --no-banner --redact --ignore-gitleaks-allow --exit-code 1 --log-opts=--all` | 0 | `no leaks found` |

The full test command passed runtime and infrastructure, then stopped in tooling.
Four tooling suites cannot import without the private-term input; process-fault
cleanup tests also reported Rolldown panic, EPIPE and injected-error assertions.
All 50 process-fault cleanup tests passed in the hosted run described below. The SDK and UI checks after
the failing tools command were executed separately, with passing results above.
The last focused server run after separating read-only user-link metadata from
protected writers also passed all 62 tests; the final typecheck passed.

The first full-suite attempts were interrupted (130) after an obsolete expiry
assertion / default-heap exhaustion. The second MCP run was interrupted (130)
after disposable-D1 failures; Node 25's missing system libatomic dependency was
installed before the third attempt. MCP's third/final invocation uses
`bun run test:mcp --bail=1 --reporter=verbose`; it ended with one failure and 1,303 passes across 36 executed files.
`P generic workflow tools cannot reach owner cancel resume or command paths`
timed out after 60 seconds (`MCP error -32001`). Two cases were skipped and
fail-fast stopped further execution; the complete MCP gate is not green.
No fourth attempt is authorized by this task's retry cap.

Hosted CI for implementation commit `6e2bd42` passed install, lint, typecheck and
CI invariants, runtime (1,856), infrastructure (85), and 167 tooling tests.
It failed only `preserves exact legal notice, vendor filename and re-export reviews`: the unchanged ts-query import moved from line 4 to line 5.
The scan-policy coordinate is now updated; its text digest and allowances are
unchanged. An independent check exited 0 with
`Exact public review coordinates verified: 106 line hashes match; all review digests and allowances unchanged`.
The corrected final head still needs a green hosted run. [Run 43021568805](https://github.com/jakubknejzlik/workbase-sdk/actions/runs/43021568805)
has the private-term input that is absent locally. Hosted results are distinct
from the blocked local scans above.

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
| MCP workflow traversal denial | `P generic workflow tools cannot reach owner cancel resume or command paths` — timed out on the third/final attempt |
| Public review coordinate after adding the compiler import | `preserves exact legal notice, vendor filename and re-export reviews` — coordinate fixed, all 106 line hashes verified; full hosted rerun pending |
| Packaging and public-export verification | `SDK CI` job: `check:ci-invariants`, `sdk-pack.sh`, boundary and public scans — blocked by missing scan input |
