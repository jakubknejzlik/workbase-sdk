# Development mailbox and first-owner onboarding

The SDK can deploy a separate mailbox Worker for disposable development/test
instances without an email provider. It reads credential-bearing messages from
the same D1 outbox as the application. Only an operator holding its dedicated
secret can read it. There are no seeded accounts or implicit admin grants.

## Provisioning

`provision()` accepts `devMailbox: { token: Input<string> }` only when `stage` is
exactly `dev` or `test`. Every other stage, including `production`, `prod`,
`preview` and `staging`, rejects this option before creating resources. Omitting
the option creates no sidecar, binding or mailbox URL output. Application Worker
code never imports the mailbox entry or mounts its routes.

Inside your existing SST `run()`, supply a stable, independently generated secret:

```ts
const deployed = await provision({
  ...applicationOptions,
  stage: $app.stage,
  ...(['dev', 'test'].includes($app.stage) ? {
    devMailbox: { token: new sst.Secret('DevMailboxToken').value },
  } : {}),
})
return {
  url: deployed.url,
  ...(deployed.devMailboxUrl ? { devMailboxUrl: deployed.devMailboxUrl } : {}),
}
```

Use 32–256 printable ASCII characters without whitespace; for example, generate
32 random bytes as hex. Set `DevMailboxToken` with your normal SST secret tooling.
Keep it separate from `BETTER_AUTH_SECRET`, `OPS_TOKEN`, and user sessions.
The provisioner marks it secret, excludes it from dry plans, and supplies it only
to the sidecar. The sidecar has only `DB`, `STAGE`, and `DEV_MAILBOX_TOKEN`
bindings, no assets, custom domain, queue or cron. Upload depends on successful
migrations. Removing the option removes the sidecar on the next SST deployment.

For this development transport, omit the application's `email` option. The normal
mail-outbox plugin then retains sign-in/invitation messages without sending them.
Keep `mailOutbox()` and magic-link authentication in the application's plugin
composition. The standalone template's default deployment still requires real
email; opt in explicitly in your authored SST configuration for a dev/test stage.
Production continues to require working mail delivery or another supported login
transport.

## Reading messages

Send `GET /messages?recipient=<exact email>&limit=20` to `devMailboxUrl` with
`Authorization: Bearer <mailbox secret>`. The required recipient scopes the lookup;
it is case sensitive and must match the address stored by the sign-in/invitation
flow. `limit` defaults to 20 and accepts integers 1–50. Messages are newest first,
with insertion order breaking timestamp ties. The JSON response is:

```json
{"messages":[{"id":"…","recipient":"owner@example.test","subject":"Workbase sign-in","body":"https://…","created_at":"…","expires_at":"…"}]}
```

An empty mailbox returns `{"messages":[]}`. Reads never send, consume or mutate
messages. Expired/used messages remain visible; the normal authentication flow
still enforces expiry and one-time use. The endpoint does not accept credentials
in cookies or query parameters, operations tokens, mutations or browser Origin
requests. It supplies no CORS headers. Every response uses `Cache-Control:
no-store`; invocation logging is disabled, and database errors return a fixed
error without SQL/message content. The runtime also returns 404 outside dev/test,
even if someone manually deploys the entry with an unsupported stage.

The Worker entry is separately exported as `@workbasehq/core/dev-mailbox` for
local Worker runners. A local sidecar needs the same persisted D1 database as the
application plus `STAGE=dev` or `test` and `DEV_MAILBOX_TOKEN`. Keep that entry and
its runner configuration separate from your application entry.

## First verified user and organization

Set `APP_URL` to the application's configured auth origin, `MAILBOX_URL` to the
sidecar URL, and `DEV_MAILBOX_TOKEN` to the sidecar secret. Use a clean dev/test
instance with `createOrganizations({ allowCreate: false })` for operator-controlled
onboarding:

1. Request a link through the application's ordinary auth endpoint:

   ```sh
   curl --fail-with-body "$APP_URL/auth/sign-in/magic-link" \
     -H "Origin: $APP_URL" -H 'Content-Type: application/json' \
     --data '{"email":"owner@example.test","callbackURL":"/me"}'
   ```

2. Retrieve that recipient's mail through the sidecar:

   ```sh
   curl --fail-with-body --get "$MAILBOX_URL/messages" \
     -H "Authorization: Bearer $DEV_MAILBOX_TOKEN" \
     --data-urlencode 'recipient=owner@example.test' --data-urlencode 'limit=1'
   ```

   Open the `body` URL from the sign-in message in the browser. For an API client,
   request it without following redirects and retain its `set-auth-token` response
   header as `USER_TOKEN`. This creates a verified identity/session, with no org
   membership yet. Links and session tokens are credentials; keep them private.

3. Complete the profile using that session:

   ```sh
   curl --fail-with-body -X PATCH "$APP_URL/me/profile" \
     -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' \
     --data '{"firstName":"First","lastName":"Owner"}'
   ```

4. As an operator, provision the first organization for the verified email:

   ```sh
   curl --fail-with-body "$APP_URL/internal/organizations" \
     -H "X-Internal-Token: $OPS_TOKEN" -H 'Content-Type: application/json' \
     --data '{"name":"First organization","ownerEmail":"owner@example.test"}'
   ```

   Configure `opsToken` separately on the application. This existing protected
   endpoint assigns the configured organization owner role; it works with
   `allowCreate: false`. Unknown/unverified owners receive `owner_sign_in_required`.
   Repeating the same owner/name returns the original receipt. The mailbox token
   grants no organization provisioning authority. With explicit self-service
   `allowCreate: true`, a signed-in user can instead use `POST /orgs`.

5. Reload `/me` or the console with the user's session. The owner membership now
   permits normal organization operations and invitations. Invitation mail can be
   retrieved through the same recipient-scoped sidecar; normal acceptance checks
   remain in effect.

The SDK tests perform this flow on an empty identity/membership database with real
D1 and the normal auth/profile/provisioning handlers, including link replay denial.
They also check the sidecar resource graph, production rejection, installed entry
resolution, and absence of mailbox code from the application bundle. They do not
deploy to Cloudflare or prove edge HTTPS behavior.
