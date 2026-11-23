# #271 preview HTTP 500 investigation

## #234 transport correction (2026-11-23)

The root, MCP package and consumer-facing standalone template now pin the exact
published Wrangler **4.129.1**, with its declared Miniflare
**5.20260907.0-alpha** and workerd **1.20260907.1**. This is the first release
containing upstream [#15252](https://github.com/cloudflare/workers-sdk/pull/15252).
There is no local Wrangler vendor patch or SDK handler retry.

The installed `wrangler-dist/ProxyWorker.js` uses `attemptUserWorkerFetch` to
retry only rejected GET/HEAD fetches against the same UserWorker origin, for at
most three attempts. It reports successful recovery with the official
`ProxyWorker: ... recovered on attempt ... after a dropped connection to the UserWorker`
warning. Received HTTP 500 responses and response-processing exceptions are not
retried. The installed CLI's DevEnv handles `Error inside ProxyWorker` by logging
`the affected request failed; the dev server continues` without a fatal error
event. This replaces the old exact-message ProxyController short-circuit.

The six contracts in `scripts/test/wrangler-proxy.test.ts` evaluate the actual
installed ProxyWorker with controlled fetch rejection, forward its reports to a
running installed ProxyController/DevEnv, and fetch the same live session after
exhaustion, POST rejection and a received-response stream-read throw. All six
pass on unpatched 4.129.1; four fail on base 4.126.0 plus its patch (GET recovery,
HEAD recovery, three-attempt exhaustion and non-fatal response-processing report).
The SDK 500 control throws from a test-only extension of the real SDK app and
checks one SDK entry, unchanged status/body/correlation header, and no retry.
The fixture does not edit installed packages or production handlers.

Triage8 remains diagnostic: A0 had 87 internal HTTP 500s; A1's scratch hunk A
recovered 123 upstream rejections with zero internal HTTP 500s. Its separate
outer client `ECONNRESET` counts remain A0 10 / A1 13, with no ProxyWorker attempt,
SDK entry or HTTP status. Their cause is unproven and outside this correction.
The hypothesis of a keep-alive reuse race near Node's five-second timeout is
not established by those counts.

Local acceptance retains the original assertions, retries, timeouts and HTTP 500
observer. Official transport recovery warnings are counted and published; they
do not independently make acceptance red. Real HTTP 500s and unrecovered errors
remain failures. Local results do not clear the technical hold on #234 / PR #256:
the fix still needs review, acceptance, merge into the release head and a new
full mandatory CI green on the final #256 head. CI 45165798417 attempt 1 remains
authoritative red until then.

## Historical observations (Wrangler 4.126.0)

Goal B is separate from the native-popup/readiness change. The underlying
connection-loss cause remains **unproven**. No causal runtime fix is claimed.

The retained 2026-11-20 trace records navigation at 13:06:49.736Z and the SDK
stylesheet request returning 500 at 13:06:49.745Z (23.87 ms, other 32 responses
200). Seven popup checks subsequently passed; the selectFocused caret check
failed at 13:06:54.137Z. Teardown began at 13:06:54.461Z and the native worker
exited at 13:06:54.479Z, code 0, expectedStop. Cleanup cannot have caused a response
4.716 seconds earlier. The native worker started at 13:01:57.881Z, about 292
seconds before the failed request. This was not its initial page load.

Worker log line 6023 records `A local preview request disconnected.` The installed
Wrangler 4.126.0 patch emits this only for `Network connection lost.`. The active
ProxyController loads `wrangler-dist/ProxyWorker.js`; its supplied TypeScript
source is `templates/startDevWorker/ProxyWorker.ts`. Do not confuse this with the
older embedded ProxyWorker used by remote bindings. The active worker queues
requests until `play` supplies proxyData. LocalRuntimeController supplies it after
Miniflare readiness. Its catch handles downstream fetch/response-processing
errors, reports the error if the downstream origin still matches, then rejects
the response. A changed/paused downstream has a separate GET/HEAD requeue path.
The patch suppresses server termination; it does not make the failed request
successful. None of these observations identify a socket, reused connection,
transport close reason, or the origin of the disconnect.

There is no recorded reload, native restart, or native exit before the failure.
The warning is consistent with a failed request against the current downstream
origin, not proof of a restart or a worker-not-ready condition. Connection reuse
and transient transport failure remain unproven; packet/socket evidence is absent.
Resource samples do not establish exhaustion. Missing historical evidence is not
reconstructed and no concurrency attribution is made.

The targeted start/load diagnostic used W29_PORT=20129, 10 fresh runtime starts,
10 sequential full console navigations per start, and the existing successful
`/health` readiness check. It recorded stdout readiness, health attempts/success,
and browser request/response timestamps. Result: **100 loads, zero HTTP 500s**.
The browser navigated immediately after setup returned, without a new sleep,
retry, or extra readiness condition. The first request followed health readiness
by approximately 23–44 ms. This finite negative result does not prove a fix or
exclude an intermittent failure in a longer-lived runtime.

The Goal B harness change observes all pages in the test's browser context. Any
HTTP 500 fails acceptance and attaches timestamp, method, URL, status, and body
(or an explicit unavailable reason). The functional manifest also records the
failure. A separate diagnostic regression verifies an auxiliary-page 500 is
rejected and its body retained; it is not part of the 147 acceptance cases.
There are no request retries, proxy patch changes, or runtime readiness changes.

A later supplementary popup diagnostic on the reserved second port 20229 failed
at B-normal iteration 20: the initial console document returned a real HTTP 500,
and the select was absent. Its worker log records that response, two local
reloads, and a crash warning. Native events record unexpected SIGKILL exits at
13:36:17.846Z and 13:36:18.173Z, replacements at 13:36:17.847Z and
13:36:18.175Z, and owned teardown beginning only at 13:36:22.744Z. There is no
preview-disconnect warning in this runtime. The sender/reason of SIGKILL and the
relationship of the response to the reloads are unproven; untimestamped log lines
cannot supply missing timing. The diagnostic overlapped local SDK-pack work,
which is context, not proof of causality. This failed diagnostic is retained and
is not counted as a passing probe or merged into the 100-load startup result.
Its response body/browser trace was not retained by that scratch probe; this is
an explicit evidence gap. Subsequent diagnostic collection retains HAR/error
artifacts and runs serially after builds. No restart-based or connection-reuse
root cause is claimed for either occurrence.
