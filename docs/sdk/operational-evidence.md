# Operational evidence

The audit plugin exposes `GET /audit/operations`. It requires authenticated organization access, the configured owner role, and `audit.read` (including the machine token operation allowlist). The organization comes from the authenticated scope. Query parameters cannot select another organization. No Console UI or notifications are involved.

Optional filters are `source=workflow|webhook|mail|audit` and `source_id`. `limit` defaults to 100 and accepts 1–100. Start with `offset=0`, then use the returned `next_offset` until it is null. The MCP data tool `read_operations` uses the same API and permissions, with `sourceId` mapped to `source_id`.

Each record contains the instance and organization IDs, source and source ID (run ID for workflows), optional step ID, creation and occurrence times, historical state, current state, fixed error code, attempt count, compensation attempt count, and age in seconds since creation. Workflow attempts describe the named step, or the run's summed step budgets when no step applies. `state` preserves the observation; `current_state` shows whether the source later recovered. Age is computed at read time. Results are newest first; offsets describe a point-in-time list and can shift when new evidence arrives.

Delivery and audit-outbox rows record their initial pending state with `backlog_pending`, plus each failed attempt. Workflow failures and attention transitions reuse the existing immutable audit events. Histories commit with their source transitions and survive resume, successful delivery, and the audit relay's seven-day cleanup. Evidence-bearing rows are retained without an automatic expiry in v1. Retained rows and histories grow with traffic, failures and relay runs; retention and compaction require a separate policy.

No payload, message body, recipient, URL, exception text, or credential enters the evidence projection. Error codes are fixed by the runtime; delivery history triggers only copy allowlisted codes. The original audit event payload remains immutable for the existing Queue/KV relay.

`GET /internal/ops` retains the instance aggregate behind the ops token. `lastRun.history` contains persisted relay snapshots, including the latest snapshot; organization evidence never includes these instance-wide measurements.

Schema changes append to the existing `workbase-sdk` / `workbase-core`, `audit`, and `mail-outbox` migration ledgers. Deploy with the normal migration path. No previously stored rows are backfilled.

Targeted tests:

```sh
bun x vitest run packages/core/test/operational-evidence.test.ts
bun x vitest run --config packages/core/test/vitest.evidence.config.ts
bun x vitest run --config packages/mcp/vitest.config.ts packages/mcp/test/data/operational-evidence.test.ts
```

The restart config uses the existing Workers Vitest harness with two standalone service-worker bundles. Their module globals and applications are separate, and all workers bind the same D1 database ID. The second reader is first invoked after recovery, verifying persistence in a fresh isolate rather than merely reconstructing an application in the test isolate.
