# Access audit locks

`access.lock.json` serializes `kernel.config.effectiveAccess` after SDK, plugin and
application command composition. `access.lock.md` presents the same grants,
expanded predicates, field masks, system/account privileges and command guards.
Executable hooks and command plans are marked opaque; generation never executes
them. Unresolved command names retain their null permission and opaque marker.

For this repository's synthetic config-era fixture:

```sh
bun run access:lock
bun run check:access
```

`check:ci-invariants` runs the same nonwriting check in SDK CI. Both artifacts are
required, including their exact formatting and repo-relative source locations.
A policy change fails with role / entity / operation diagnostics. Source-line
changes also require regeneration. Commit both generated artifacts together.
There are no timestamps or absolute source paths; JSON uses sorted keys and a
compact line, while Markdown groups the four operations by role and entity.

Consumers can wire `runAccessCli` from `@workbasehq/core/access/lock/cli` with
`--config config.ts --root . --directory .`. Add `--write` for the writing script.
Config modules are trusted executable application code. The CLI composes their
registered plugin and SDK commands through `KernelRegistry` before serialization.
Legacy `defineInstance` configs skip with a message and exit 0, even with `--write`.

For a runtime with separately supplied command registries, call `syncAccessLock`
from `@workbasehq/core/access/lock` with that composed kernel, `root` and `sources`.
Use `loadConfig(...).sources` for literal configs or `configSources(configPath)`
from `@workbasehq/core/schema/load` for executable configs. The latter only indexes
source metadata. A source map may additionally identify `guards.<command>` and
`hooks.<plugin>.<hook>`; otherwise these point to the enclosing command/plugin
registration in config.ts. Imported executable bodies remain opaque.

The audit is a review artifact. Drift detection provides no signature or tamper
protection. Authorization continues to consume the existing normalized policy.

Both locks also include `enforcementInputs`, taken from the actual composed kernel
(including runtime plugin overrides and trust). This explicit section is needed
because account projection, SQL issuer guards and plugin ports consume config and
runtime state outside the grant compiler. Moving those consumers into that
compiler would change their execution contracts; this audit does not change them
or derive grants again. Relation bindings retain the exact `entity`, `field` and
`many` values used to resolve predicate `field`/`parentField`. Drift diagnostics name
the changed input path and values. Opaque hook bodies remain opaque, including
their arbitrary application-specific config reads.

Inventory of SDK access enforcement inputs (paths under `packages/core/src`):

| Reads (file:line) | Representation in the lock |
| --- | --- |
| `access-evaluator.ts:11,20,46`: roles, entity decisions/operations/masks, system decisions/targets | `effectiveAccess.roles/entities/system` |
| `kernel/registry.ts:185`: command permissions/additional permissions, guard lookup | `effectiveAccess.guards` (registered command bodies stay opaque) |
| `kernel/registry.ts:82,157,182,212`: trust, permissions provider presence/activation | `enforcementInputs.authorization.trust/permissionsActive/providers` with resolved provider names/versions |
| `kernel/registry.ts:160,173,199`: plugin hooks, builtin provenance, authorization, policyInConfig | `enforcementInputs.plugins` plus `effectiveAccess.opaqueHooks` |
| `kernel/registry.ts:89,102`: identity/organization/member port selection | `enforcementInputs.authorization.providers` |
| `policies.ts:18,21,81,123,235,239`: account entity, assignments, managedBy | `enforcementInputs.account` |
| `policies.ts:39,154`; `query/schema.ts:51`: relation entity/field/many (including nested dependencies) | `enforcementInputs.entities.*.relations` |
| `policies.ts:18,42,84,254`; `query/schema.ts:19,21,56`: entity/field existence, type, computed, readOnly, userLink; compiler masks also read sensitive | `enforcementInputs.entities.*.fields` (also records ref targets and enum values) |
| `policies.ts:48,124`; `execution/policy-receipts.ts:13`: effective rules and compatibility policies/account; plugin tableFilter/policyInConfig/builtin | `effectiveAccess.entities`; `enforcementInputs.policies/account/plugins` |
| `organization-permissions.ts:8,16,35,54`; `organization-rules.ts:9,27`: roles, organizationOwnerRole, organizationPermissions | `enforcementInputs.roles/organizationOwnerRole/organizationPermissions`; grants remain in `effectiveAccess` |
| `execution/policies.ts:75,114,115`; `execution/policy-receipts.ts:22,45`: schema membership, userLink protection, account entity, compiled-policy presence | `enforcementInputs.entities/account`; `effectiveAccess` |
| `user-link-fields.ts:5`; `user-links.ts:30,63,102`: entity/field userLink registry and generated command names | `enforcementInputs.entities.*.fields`; `effectiveAccess.guards` |

Compatibility `permissions` is recorded too. Scope credentials, live memberships,
actor attributes, database rows and request command inputs are runtime data, not
declarative lock inputs. Source locations remain in `sources`; no host paths or
timestamps are added.
