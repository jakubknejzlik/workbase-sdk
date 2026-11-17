# Invitation delivery and copied links

Members and V3 worker invitations use the same acceptance URL builder. The
configured `AUTH_BASE_URL` chooses the exact origin; Identity's configured
`baseURL` remains a compatibility fallback. HTTP is allowed only for local
loopback development. The path is always `/invitations/accept`.

E-mail and Copy link have independent random selectors. `token_hash` identifies
the unsigned management/copy selector, which requires the matching recipient's
verified session. `delivery_token_hash` identifies the delivered selector. Only
the mail transport receives that selector with its mailbox proof. Both links are
built and checked for their purpose by `buildInvitationAcceptUrl`. Copy link
rotates only the copy selector and preserves the delivered selector and outbox
association. Manual Resend rotates both selectors and creates a new reminder
intent. Accepting either consumes the same invitation.

The Members Console Copy link action calls the management copy endpoint. The
record access dialog does the same; the SDK access card can also copy the
unsigned value returned by its invite action. None receives the delivered
selector or proof. The copied value is absent from the delivered message.

Anonymous copied links show **Sign in to accept** and ask the recipient to sign
in with the invited e-mail address. This navigation preserves the invitation's
opaque ID in `returnTo` and makes no acceptance request. After sign-in and any
required profile completion, **Accept invitation** explicitly confirms membership.
Delivered links retain their mailbox-proof session and confirmation flow.

The public preflight metadata contract is curated in
`packages/core/src/openapi/public-paths.ts`: invitation ID, organization ID/name,
inviter display name, role, expiry, state, account match, and optional target
entity/row selectors. Recipient preview also carries navigation, return target,
profile completeness, next step and actions. The target row is an API selector;
the invitation card displays the entity context without printing that internal ID.
Recipient e-mail, credentials, hashes and profile data are outside preflight's
contract. The response field set is unchanged.

Outbox rows store template inputs in `body`: display metadata,
locale, timezone, expiry, configured origin and the unsigned delivered selector.
`delivery_html` and `delivery_text` are empty placeholders. On each send/retry,
Members checks the stored selector against the live invitation's delivered hash,
builds and verifies a fresh acceptance URL with the current signing key, then
passes only that branded URL and template metadata to the renderer. The template
escapes display values and HTML attributes; it never constructs a URL. One
unique acceptance URL appears once in text and in the existing HTML button and
fallback (two hrefs and the visible fallback).

There is no rendered-content scanner, URL substitution or replacement count.
Stored HTML/text, including null or tampered values, cannot supply a delivered
link. Invalid inputs or a failed URL/proof verification fail the claimed attempt
with `failed` / `email_send_failed` before native send. No proof is persisted in
the outbox or serialized operation plan.

The input object has no format-version marker: `selector`, `origin` and
`template` describe the current payload. Historical formats are unsupported;
missing or malformed inputs follow the normal `email_send_failed` path. Migration
005 remains part of the current copy/delivery credential separation.

The shared outbox still claims an attempt before rendering, sends through the
native binding, and fences sent rows and ambiguous timeouts. A rendering failure
can be repaired and retried with one native send; retrying a sent row performs no
render or send. Native provider rejection remains retryable; its attempts are
counted separately from a successful delivery. Post-commit callbacks and their
per-operation WeakMap registration are unchanged.
