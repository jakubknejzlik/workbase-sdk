# Workers List config v2 example

From the repository root, with dependencies installed:

```sh
bun packages/core/examples/list-v2-workers.ts
bun run typecheck
bun x --no-install vitest run packages/core/test/list-v2-release-example.test.ts
```

The module uses public package exports and `ListInput`, then calls the shipped
`defineInstance` validator. It exports the normalized configuration; it needs no
credentials, database, deployment or running instance. The test also projects it
through the console authority model. All entities and grants are synthetic.

In a 0.4.0 consumer, copy this module alongside your configuration and import its
list hints; adapt entities, account links and grants to that instance's schema and
access definition. This is a runnable configuration example, not a provisioned
application. [Migration notes](../../../docs/sdk/migration-0.4.0.md) explain
pagination, compatibility and row-access gates.
