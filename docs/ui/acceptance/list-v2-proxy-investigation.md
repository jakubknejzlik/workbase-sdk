# #271 preview HTTP 500 investigation

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
