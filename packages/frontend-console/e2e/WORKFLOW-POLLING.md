C5 workflow polling reproduction (Refs #97)

Run from the SDK root with dependencies and Playwright Chromium installed:

```sh
bun run console:build
bun run --cwd packages/frontend-console typecheck
(cd packages/ui && bun x --no-install vitest run test/workflow-polling.test.tsx)
C5_ARTIFACT_DIR="$PWD/test-results/c5-workflow" \
  bun x --no-install playwright test \
  --config packages/frontend-console/playwright.workflow-polling.config.ts \
  --repeat-each=20 --retries=0
```

`console:build` requires the repository's private vocabulary gate inputs. For a
local fixture without those inputs, build the same frontend assets with
`bun run --cwd packages/frontend-console build`, then write the build metadata
that the shell needs (an absent date becomes `unbuilt` and cannot be formatted):

```sh
bun - <<'TS'
import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { CONSOLE_SHA_MARKER, consoleArtifactsSHA, readConsoleArtifacts } from './packages/core/src/console-build'
const directory = 'packages/frontend-console/dist'
const files = await readConsoleArtifacts(directory), sha = consoleArtifactsSHA(files)
for (const [name, bytes] of files) {
  if (name.endsWith('.html') && bytes.includes(CONSOLE_SHA_MARKER)) {
    writeFileSync(`${directory}/${name}`, Buffer.from(bytes.toString('latin1').replaceAll(CONSOLE_SHA_MARKER, sha), 'latin1'))
  }
}
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
writeFileSync(`${directory}/build-meta.json`, JSON.stringify({ sha, sourceCommit, builtAt: new Date().toISOString() }))
TS
```

Each repetition creates a fresh `run-*` persistence directory, seeds synthetic
running rows before `wrangler dev`, and disposes both seeding proxies before the
browser starts. Only the fixture Worker holds D1 during the browser phase. No
workflow engine or scheduler is invoked; this reproduces polling and fixture
mutation behavior, not workflow execution or the historical contention source.

The fixture-only authenticated `POST /__test/c5` is the sole live mutation path.
A workflow detail response receives a read token. After Playwright verifies that
this response is running and the real UI renders Running, it acknowledges the
token. Completion is rejected until this barrier is acknowledged. The next real
three-second poll renders Completed. The test observes zero further workflow
GETs for 6.5 seconds, then proves another running run polls and uses an in-app
link to unmount it. A second 6.5-second window checks zero workflow GETs after
navigation has settled. These are bounded observations, not a claim about all
future time. No browser responses are mocked and no production cadence changes.

Artifacts are deliberately retained under `C5_ARTIFACT_DIR` (default:
`test-results/c5-workflow`): `results.json`, per-run `summary.json`, `worker.log`,
persisted D1, Wrangler logs, and `failure.json` on assertion/setup failure.
Playwright also attaches diagnostics and retains traces on failure. Fixture
control/auth secret values enter Wrangler through the child environment,
privileged control calls use untraced Node fetch, and teardown
checks every retained run file for both values. The final artifact reporter
redacts bearer credentials in trace ZIPs and retained JSON/logs after Playwright
finishes writing them, including the synthetic browser session header.
Diagnostics include operation labels, HTTP statuses/body, nested D1 error causes
before HTTP sanitization, Worker log excerpt, and persistence directory. The D1 adapter only
observes and rethrows errors; it never retries. `maxFailures: 1` stops repetitions
on failure, including any BUSY found in Worker logs. Stop and report a
Worker-owned BUSY rather than adding a runtime fix in this reproduction slice.

`C5_PORT` overrides the default 19497; occupied ports are rejected. Fixture
teardown stops the Worker even when the test fails. For task-specific scratch
constraints set `C5_ARTIFACT_DIR` to the allowed scratch root and use a short
`TMPDIR` (a short symlink into that root also works for Unix socket limits).
Do not set `WORKBASE_KEEP_TMP`.
