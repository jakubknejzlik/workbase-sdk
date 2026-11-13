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
