# Deterministic interactive source derivation

`deriveInteractiveSource(source, change, config)` is an internal MCP source
operation in `packages/mcp/src/composition/runtime-source.ts`. It accepts source
text, one unknown operation parsed by the existing strict `setInteractiveSchema`,
and the existing `CompositionConfig` roles/organization-owner-role values.
Only `{ kind: 'set_interactive', interactive: boolean }` is accepted. Arrays,
other kinds, extra members and incorrect types are rejected.

The source and config are base-derived data supplied by the caller. This API
does not certify their origin. A future service must obtain both from its own
immutable-base adapter, rather than agent claims.

The operation parses the canonical runtime AST, applies the single change using
`applyRuntimeChanges`, and rewrites it using `rewriteRuntimeSource`. It returns
`{ model, files: [{ path: 'runtime.ts', data }] }`, always with exactly that one
fixed path, even when the emitted bytes already match the source. Permissions
options are derived from the supplied config. Existing canonical parsing errors,
including located `runtime_not_canonical` diagnostics, are preserved.

Equal source bytes, ordered config values and operation produce equal output
bytes under the pinned SDK and toolchain. The source layout is part of the input:
this is not a promise that arbitrary layouts normalize to identical bytes. The
existing import/comment/alias splicing rules apply, including compatibility
singleton-to-factory normalization and replacement of the runtime object. Not
every input byte outside an interactive token is preserved. Reapplying an
operation to its emitted source is byte-idempotent.

There is no root directory or caller-selected output path, shell, filesystem,
Git, network, clock, randomness, database, consumer module evaluation or write
side effect in this API. It does not hydrate runtime plugins. It uses the fixed
SDK registry's existing schema and normalization helpers; this is not a claim of
Worker-only portability.

The composition workflow's `prepare` seam uses this API when its runtime changes
contain exactly one `set_interactive`. It takes the returned model and runtime
bytes, then continues existing hydration, replay-engine checks, proof generation,
changed-file filtering and access/catalog/presentation processing. Other runtime
batches and role-only changes retain their existing paths.

Successful text derivation does not validate a complete composition. Enabling
interactive login still requires the appropriate provider graph downstream.
This operation does not generate migrations, verify replay, fetch a trusted base,
publish anything or introduce infrastructure. Tests use synthetic inline byte
goldens, frozen inputs, fresh Node processes and local workflow fixtures; broader
promote/disposable behavior remains covered by the full MCP regression suite.
