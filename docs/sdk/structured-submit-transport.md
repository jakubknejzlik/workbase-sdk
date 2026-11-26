# Internal structured-submit transport

This SDK protocol/client boundary is for a future operator-hosted receiver. It
creates no remote service or infrastructure. Import it from the existing internal
`packages/mcp/src/submit-change.ts` module; no package entry point or MCP tool is
added. The existing `submit_change` tool keeps its proof gates, local promoted-file
publication, configuration, response and retry behavior. Its publication does not
become service provenance through this transport.

```ts
import {
  createStructuredSubmitTransport,
  structuredSubmitRequestDigest,
} from './packages/mcp/src/submit-change.ts'

// Configure only in operator code. This synthetic endpoint is not a service.
const transport = createStructuredSubmitTransport({
  endpoint: 'https://receiver.example.test/internal/submit',
  credentialProvider: async () => 'synthetic-service-token',
  // fetch: injectedFetch, // defaults to global fetch
})
const request = {
  changes: [{ kind: 'add_role', role: 'reviewer' }],
  baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  proposalId: '123e4567-e89b-42d3-a456-426614174000',
}
const digest = structuredSubmitRequestDigest(request) // identity, not authority
const result = await transport.submit(request, new AbortController().signal)
```

The request has exactly `changes`, `baseSha` and `proposalId`: 1–50 operations
from the existing `changeSchema`, `compositionChangeSchema` and
`schemaChangeSchema` union, a lowercase 40-hex base SHA, and a UUID. Unknown
envelope and operation members are rejected. File maps, promoted bytes, migration
SQL, receipts, hashes, repository/branch/path routing and credentials are not
authorization fields. Legitimate captions, structured constraints and serialized
expression/predicate data remain governed by their existing operation schemas;
there is no lexical ban on words such as SQL.

Before any schema transformation, credential callback or network call, the client
requires plain JSON data. Functions, undefined, BigInt, symbols, non-finite
numbers, cycles, non-plain objects, accessors, hidden members and sparse/extended
arrays are rejected. Parsing copies the input and never mutates it. Object keys
are sorted recursively before operation schemas run (including expression-object
serialization), then the validated request is encoded with sorted object keys and
preserved array order. The canonical JSON body is UTF-8; its SHA256 lowercase hex
is the digest. There is no fourth digest field. Expression strings are data and
are not parsed or semantically normalized by this client.

Operator configuration fixes an HTTPS endpoint without URL credentials or a
fragment, an optional Bearer service-token provider, and a fetch implementation.
The factory captures these values. `submit(unknownRequest, optionalSignal)` cannot
override endpoint, routing or authentication. No GitHub App key or GitHub write
adapter belongs here. One call sends one POST with JSON content type,
`redirect: "error"`, the canonical body and the supplied signal. There is no
automatic retry. An explicit identical repeated call sends identical body bytes.

Success is strictly `{ok: true, prUrl, prNumber, headSha, checkState,
previewState}`: HTTPS URL, positive integer PR number, lowercase 40-hex head SHA,
and states `pending | success | failure`. This validates shape only; it is not
authentication, independent re-derivation, verification or admission proof.
Invalid requests throw `WorkflowError` with `invalid_structured_submit_request`
(status 400). Invalid/missing configuration, credential failures, transport or
abort failures, non-2xx responses, malformed JSON and malformed successes use
`structured_submit_unavailable` (503), with the fixed message
`Structured submission is unavailable.` HTTP 409 uses
`structured_submit_conflict` (409), with the fixed message
`Structured submission conflicts with an existing proposal.` Remote bodies,
provider/exception text and credentials are never logged or attached to errors.
Redirects are rejected by fetch rather than forwarding authentication.

## Future receiver obligations

The authoritative receiver must resolve its configured instance and repository
independently of caller data, fetch the immutable base, independently recompute
the request digest, derive and verify changes, and publish only verified output.
Semantic expression, graph, baseline, mixed-family and authorization checks remain
there; accepting a transport-schema union combination does not mean that the
receiver supports it.

The receiver must durably bind each proposal ID to its request digest, return the
original result for an identical retry, and reject changed input for an existing
ID. Tests that simulate repeated successes or HTTP 409 establish only this
client's serialization and error behavior. **Durable, cross-restart and concurrent
idempotency remains later service work.** This slice implements no receiver,
persistence, trusted Git-base retrieval, verifier, receipt writer, credential
service, production deployment or admission enforcement.
