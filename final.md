# Issue #43 s2 implementation

Implemented the SDK development mailbox as a separate opt-in Worker, with no
application Worker route/import and no production resource by default. Enabling
it outside the exact `dev` and `test` stages fails before resource registration.
The runtime independently rejects unsupported stages.

The supplied issue snapshot was read before changes. It contains the original
issue body and an empty comments array, so no latest triage/design comment was
available. Scope follows the explicit s2 request and the existing slice-1
organization provisioning implementation at base commit `7d73000`. GitHub was
not accessed.

## Changes

- Export `@workbasehq/core/dev-mailbox` as an independent Worker entry. Its only
  operation is authenticated `GET /messages` with a required recipient and a
  bounded limit (default 20, maximum 50), using bound SQL parameters and stable
  newest-first ordering. It returns outbox bodies without delivery/state writes.
- Require a dedicated 32–256-character mailbox secret. Reject browser Origin
  requests, cookie/query credentials, other methods, malformed queries and
  unsupported stages. Return no-store JSON, no CORS, and fixed database errors.
- Add `devMailbox: { token }` to SDK provisioning and optional `devMailboxUrl` /
  `resources.devMailbox` outputs. Bind only the existing stage D1 database,
  `STAGE`, and secret `DEV_MAILBOX_TOKEN` to the sidecar. Preserve migration-before-
  upload ordering, disable invocation logging, and omit secrets from dry plans.
- Test production rejection/default omission, separate bindings and secrets,
  installed package/SST bundle resolution, executable sidecar browser bundle,
  and absence of mailbox code from the application bundle/import graph.
- Document setup and first-owner onboarding through normal magic-link sign-in,
  sidecar retrieval, profile completion, and slice-1 protected organization
  provisioning, including `allowCreate: false`. Update the changelog and guides.

## Red → green and checks

All commands used the task scratch directory as `TMPDIR`. Dependencies installed
with `bun install --frozen-lockfile`; Node v25.8.0 and Bun 1.4.3.

| Check | Result | Evidence file |
| --- | --- | --- |
| New runtime tests against an empty 404 handler before implementation | RED: all 5 tests failed | `red-runtime.log` |
| Provision tests before implementation | RED: 7 new failures, 31 existing tests passed; production incorrectly accepted mailbox input | `red-infra.log` |
| Runtime: mailbox, Better Auth, organization provisioning | GREEN: 27 tests across 3 files | `green-runtime.log` |
| Infrastructure: provision graph, runtime boundary, installed-package loader/bundles | GREEN: 40 tests across 3 files | `green-infra.log` |
| `bun run typecheck` | Passed all three TypeScript projects | `typecheck.log` |
| `bun run lint` and `git diff --cached --check` | Passed | `lint.log` |
| `bun run check:ci-invariants` | Blocked: missing maintainer private vocabulary (`WORKBASE_PRIVATE_TERMS`) | `invariants.log` |

Runtime command:

```sh
bunx vitest run packages/core/test/dev-mailbox.test.ts packages/plugins/organizations/test/provision.test.ts packages/core/test/better-auth.test.ts
```

Infrastructure command:

```sh
bunx vitest run --config vitest.infra.config.ts packages/core/test/infra/provision.test.ts packages/core/test/infra/runtime-boundary.test.ts packages/core/test/infra/packed-provision-loader.test.ts
```

Logs originate in
`/tmp/codex-scratch/codex-wr-workbase-jakubknejzlik-workbase-sdk-43-s2/`.
Their archive location is
[/Users/jarvis/.sitebrew-work/evidence/codex-wr-workbase-jakubknejzlik-workbase-sdk-43-s2/](/Users/jarvis/.sitebrew-work/evidence/codex-wr-workbase-jakubknejzlik-workbase-sdk-43-s2/).

## Remaining concerns

- No Cloudflare deployment, remote email delivery, or edge HTTPS acceptance was
  performed. The graph uses SST mocks; runtime/D1 and installed package bundles
  were exercised locally. The full repository test matrix was not run.
- The combined CI invariant command cannot pass without the maintainer-supplied
  private vocabulary; its subsequent UI check did not execute. Runtime test logs
  also contain dependency deprecation/source-map warnings, with no test failures.
- Mailbox access grants read access to credential-bearing mail for any recipient
  in that disposable stage. Keep its independent secret private, use a disposable
  database, and remove the opt-in when finished. Expiry/replay enforcement remains
  in normal auth; mailbox reads do not consume or redact stored messages.
- This slice supplies SDK provisioning and the operator HTTP transport. It adds
  no MCP tool or email-provider integration. The supplied snapshot does not allow
  verification against an unavailable triage comment.

Changes are committed locally as requested. No push was performed.
