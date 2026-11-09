# Row policies

Entity permissions grant operations; `policies` restrict the rows for each role.
Omitted entity/role policies deny access. A policy can be `'all'`, `'none'`, or
`{ where: { ... } }`, with scalar comparisons, declared relations, and `and`, `or`,
and `not`. Trusted policies can compare scalar fields to `$actor.id` and other
declared actor fields, resolved from the live account and membership.

## Linked actors

Use `actorLinkedIn` when access depends on the actor having a protected user link
in another entity, even when the requested rows have no relation to that entity:

```ts
policies: {
  jobs: {
    worker: { where: { actorLinkedIn: 'people' } },
  },
}
```

The inspected entity must declare a protected `userLink: true` reference to
`users` (with `account.entity: 'users'`), or configuration validation fails.
The predicate checks the current organization, the live account and membership,
and, for machine credentials, the live token issuer. Clients cannot supply an
account ID or use this operator in queries. It composes with the ordinary policy
boolean operators; it takes only an entity name.

This authority check bypasses the inspected entity's own read policy. One indexed
EXISTS checks the link and authority in reads and in atomic write pre/post-image
guards. Unlinking or removing membership takes effect on the next request;
changes between write preparation and the atomic batch also deny the write.
MCP `set_policy`, proposal validation, and config serialization preserve it.
