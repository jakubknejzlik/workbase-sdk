# Invite an account from a domain row

A domain entity uses an optional protected ref to built-in `users` (`userLink: true`) with a declared relation, and `account.entity: users`. The configuration MCP's `add_user_link` change supplies that field/relation/protection. Membership roles are separate from domain entities. Give `member` the intended business permissions and policies through `$actor.id` and the user link. Give the inviting role entity `create` plus `invitations.create`; `member` permissions must be a subset of that role's permissions.

With Members installed, the generated console offers row access state and actions on authorized linked entities. Czech states are **Bez účtu**, **Pozváno**, **Vypršela**, **Přihlášen**. Enter an email under **Pozvat do aplikace**. No phone or role picker is involved. Resend rotates the credential; cancel frees the row for a different email. Remove access clears all configured links for that account in the workspace, keeps its users row and revokes outstanding invitations to that account. Membership removal does the same cleanup, with the existing last-owner guard.

`POST /orgs/:orgId/invitations` accepts:

```json
{ "email": "recipient@example.test", "target": { "entity": "people", "row": "person-id" } }
```

The target always grants `member`; an explicit different role is rejected. An existing workspace member must confirm too; acceptance preserves their current membership role. Generic invitations without a target retain their existing API. Only the signed-in matching verified recipient can accept; anonymous email entry establishes identity and preview/profile flow first. The invitation stores its target, and acceptance claims it, provisions the users row/membership if needed, checks uniqueness and writes the protected link in one atomic batch. A conflict returns 409 with no partial claim, membership, link or success audit. A previously consumed credential replay never restores removed links/membership. A new invitation alone never restores access.

`GET /orgs/:orgId/row-access/:entity/:rowId` returns `state` (`no_account`, `invited`, `expired`, `signed_in`) and live management hints. It enforces entity read permission and row visibility, private/no-store caching, and invitation permissions. The recipient preview identifies the row they are confirming. Runtime console-model metadata enables the generic UI from the installed Members plugin, registered links and live invite/create permissions.

The data MCP exposes `row_access`, `invite_from_row`, `resend_row_invitation` and `cancel_row_invitation`. `run_command` retains explicit Link/Remove access support. Invitation tools use normal HTTP authorization and are unavailable for writes in read-only mode; they never return an acceptance credential. A delegated machine credential needs the entity and invitation operations in its exact operation allowlist (or an unrestricted allowlist), the stored role grants and the issuer's live grants. Issuer removal/demotion, credential revocation/expiry and a changed prepared role fail closed. Other membership/token administration remains session-only. The initial invitation stores the human issuer, retaining the existing acceptance-time issuer/subset check.

Upgrade with the normal append-only Members plugin migration runner. Migration `004_row_invitations` adds nullable `target_entity`/`target_row`, a unique pending-row index and an expiry trigger. Existing invitation history remains untargeted; existing migrations and checksums remain unchanged. No SDK version bump or release is part of this change.

## Exact delegated-token operation allowlists

Role grants and token operation restrictions are separate checks. The stored token
role and the issuer's **live** role must both allow the action; row policies and
role-subset checks still apply. Operation names are exact strings, with no wildcard
or dot/slash substitution. The entity name below is `people`; replace it with the
configured linked entity.

| HTTP action | Complete token `operations` minimum |
| --- | --- |
| Read row access / filter `/query` by access state | `people.read`, `invitations.read` |
| Invite from a row | `people.create`, `invitations.create`, `invitations/create` |
| Resend a row invitation (including expired) | `people.create`, `invitations.create`, `invitations/resend` |
| Copy a pending row invitation link | `people.create`, `invitations.create`, `invitations/copy_link` |
| Cancel a row invitation | `invitations.revoke`, `invitations/revoke` |

For example, a credential that only invites from `people` rows uses:

```json
{
  "role": "owner",
  "operations": ["people.create", "invitations.create", "invitations/create"]
}
```

An integration that reads, invites, resends, copies and cancels uses:

```json
{
  "role": "owner",
  "operations": [
    "people.read", "people.create", "invitations.read",
    "invitations.create", "invitations.revoke",
    "invitations/create", "invitations/resend",
    "invitations/copy_link", "invitations/revoke"
  ]
}
```

These examples describe the operations field of a session-issued credential; token
administration and recipient acceptance remain session-only. A status-only token
may read state but receives no management actions. The data MCP invitation tools
continue to discard credentials; the explicit copy-link HTTP action returns a
credential only after live invite/create and row-policy authorization. Copying
rotates the credential, invalidates previous links, and preserves expiry; it does
not prove mailbox ownership. The recipient must still authenticate as the verified
matching email. Resend instead issues a fresh credential with a new seven-day
expiry and sends a new email.

The console filter uses the normal paginated `/query` document, for example:

```json
{ "entity": "people", "select": ["id", "name"], "rowAccess": "expired", "limit": 30 }
```

Allowed `rowAccess` values are `no_account`, `invited`, `expired`, `signed_in`.
Filtering runs on the server before pagination and composes with entity and row
policies. It requires Members, a configured user link, entity read and invitation
read authority. It returns ordinary rows, never invitation tokens or links.

Expiry is derived from existing `expires_at` / `expired_at`; no migration is needed.
Unaccepted invitations expire seven days after creation or resend. Acceptance
returns HTTP 410 `invitation_expired` for an expired credential, with no link or
membership write. A later invitation supersedes earlier row history, including
when that later invitation is cancelled. Resending superseded history returns 409.
For `member`, console navigation contains only readable entity destinations;
workspace administration and settings sections are omitted, with personal profile
remaining available from the account menu. Existing API authorization still applies.
