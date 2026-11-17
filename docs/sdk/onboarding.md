# First-owner onboarding without real mail

Use the standalone template on a disposable `dev` or `test` stage to establish
the first owner, invite staff and verify access without an email provider.
There are no seeded identities. The template keeps `registration: 'open'` so
the first user can sign in, and uses `createOrganizations({ allowCreate: false })`
so organization creation requires an operator. Invite-only first-user registration
is outside this flow.

After [installation and artifact generation](getting-started.md), copy
`deploy.env.example` to private `.env` and configure the Cloudflare, auth and
resource inputs. Set independent `BETTER_AUTH_SECRET`, `WORKBASE_OPS_TOKEN` and
`WORKBASE_DEV_MAILBOX_TOKEN` secrets. For the mailbox secret's format and security
contract, see [development mailbox](dev-mailbox.md). Leave `EMAIL_FROM` empty;
the template rejects it together with `WORKBASE_DEV_MAILBOX_TOKEN`. Deploy with
`bun run deploy --stage dev` (or `test`). The mailbox is rejected on every other
stage. Without a mailbox token, the template requires an authorized `EMAIL_FROM`.

The SST output includes the application `url` and optional `devMailboxUrl`.
Set `WORKBASE_BASE_URL` to the canonical application auth origin and
`WORKBASE_DEV_MAILBOX_URL` to the sidecar output. Export those plus
`WORKBASE_OPS_TOKEN` and `WORKBASE_DEV_MAILBOX_TOKEN` in the environment of your
MCP client, then start or restart its `workbase_ops` server from `.mcp.json`.
SST loads `.env`; the MCP client needs its own environment. Keep secrets out of
MCP arguments, committed JSON and transcripts. The template passes
`WORKBASE_OPS_TOKEN` to `provision({ opsToken })`, which binds the application's
`OPS_TOKEN`; the mailbox receives its separate secret.

1. Open the application in a browser and request a magic link for
   `owner@example.test`. Use synthetic addresses for disposable acceptance.
2. Call `read_dev_mail({ recipient: "owner@example.test", limit: 1 })` on
   **workbase_ops**. In its `data.messages`, select the sign-in message and open
   its `body` URL in that browser. Complete the profile. Mailbox reads do not
   consume links; normal auth still enforces expiry and one-time use.
3. Call `provision_organization({ name: "First organization", ownerEmail: "owner@example.test" })`.
   The tool calls `POST /internal/organizations` with the ops credential and
   assigns the configured owner role (`admin` in the template). The owner must
   already have a verified identity; otherwise it returns
   `owner_sign_in_required` (409). Repeating the same owner/name replays the
   organization. Refresh the console to see the owner's membership.
4. As owner, create a worker record and use its invite action for
   `staff@example.test`. In a separate browser profile, request the staff
   magic link and read it with `read_dev_mail`. Sign in and complete the profile,
   then read that recipient's invitation message (increase `limit` to see both
   messages). Open the URL following `Accept: ` in its `body` and accept the
   invitation. Invitation URLs come through the mailbox tool; the data MCP
   server strips `accept_url` from its results.
5. Verify owner CRUD and staff access to the linked worker. Sign in a second
   owner through the same mailbox flow and provision a second organization;
   verify that its owner cannot read or modify the first organization's records.
   Self-service `POST /orgs` remains forbidden with `allowCreate: false`.

The ops server needs no tenant token or organization ID. The adjacent
`workbase_data` server separately requires an issued `WORKBASE_TOKEN` and
`WORKBASE_ORG_ID`; it defaults to read-only mode. Browser CRUD is sufficient for
the acceptance flow above. See the [ops tool contract](dev-mailbox.md#operator-onboarding-with-mcp)
for response/error shapes and the underlying mailbox transport.

Remove the disposable stage with `bun run remove --stage dev` (or `test`).
For production, omit both mailbox MCP variables and the deployment mailbox token,
configure real mail delivery with `EMAIL_FROM`, and use the same ops provisioning
tool after the owner's delivered sign-in. Record deployed acceptance separately
using the [phase-2 checklist](phase-2-checklist.md).

## Members without Organizations

For a Members-only composition, sign in with a magic link and verify the intended
owner as above. Login alone leaves `/me.memberships` empty and instance-scoped APIs
return `organization_forbidden` (403). With `WORKBASE_BASE_URL` and
`WORKBASE_OPS_TOKEN` exported, run:

```sh
workbase ops bootstrap-instance-owner --owner-email owner@example.test
```

Alternatively, call `bootstrap_instance_owner({ ownerEmail: "owner@example.test" })`
on the MCP server started by `workbase ops`. Both use
`POST /internal/members/instance-owner` with `X-Internal-Token`, protected by the
same middleware as organization provisioning: runtime `OPS_TOKEN` takes precedence
over legacy `INTERNAL_TOKEN`. No tenant credential or scope argument is needed.
The route is mounted only with Members and login, without Organizations.

The identity must already exist and have verified email (`owner_sign_in_required`,
409 otherwise). Bootstrap grants the configured `organizationOwnerRole` in the
existing `instance` scope and returns `{ organization_id, user_id, role, replayed }`
with status 201. Refresh `/me` to see the membership and access the scoped API.
An identical owner email (case-insensitive) returns the durable receipt with status
200 and `replayed: true`, even if the original membership later changes; a replay
never restores grants. A different owner, or any existing owner without that
receipt, returns `instance_owner_exists` (409). An existing non-owner membership
for the target returns `membership_conflict` (409). Bootstrap never creates an
identity or session. Use the normal member-management routes for subsequent grants.
