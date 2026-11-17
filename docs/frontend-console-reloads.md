# Console deployments and custom forms

The served frontend console observes deployment identity from `build.json` SHA.
The first valid SHA is the baseline; missing metadata, `unbuilt`, and failed reads
are not observations. Revision-only capabilities changes refresh the runtime model
and request fresh build metadata; the same SHA does not hard reload the page.
Runtime refreshes apply new permissions and failed reads render the existing error
UI. Successful refreshes keep the runtime host and create editor mounted so registered
create drafts survive. Detail Edit still has an open limitation: its generated
read query changes key with capabilities and removes the action dialog while
loading fresh rows. That generated-screen lifetime requires follow-up outside
the small read/runtime host change; an expected-failure regression test records it.

A single root coordinator keeps the latest pending SHA outside the query cache.
It waits until every mutation session is clean and all submissions have settled,
then rechecks after React commits and accepted navigation settles. Successful
save, confirmed discard, or reverting to pristine can release an update. Failed or
invalid saves and cancelled discard retain the draft and pending update.

Custom forms participate by calling `useMutationForm` (React Hook Form) or
`useMutationState(isDirty, reset)` inside a `MutationSession`. Use
`useMutationSubmit` or the session's `run` for asynchronous submissions, and reset
after successful page saves or call `complete` when closing a successful dialog.
Registration outside a session does not protect a draft. No form values enter the
coordinator or its storage record.

Persisted `pageshow` (BFCache restore) rechecks pending work and fetches fresh build
metadata. Reload attempts are latched synchronously and recorded in per-tab
session storage under `workbase:frontend-console:reload-attempted-shas` before
reload, storing only build identifiers. Storage failure leaves the document's
in-memory protection active. Repeated signals for an attempted SHA cannot loop;
a newer SHA replaces an older deferred target.
