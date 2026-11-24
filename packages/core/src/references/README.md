# Internal snapshot reference analysis (S1)

`capture()` reads an explicitly selected root and package export map. It captures exact UTF-8
source/dependency bytes and records unresolved resolution edges. It never searches host
`node_modules`. `snapshot()` copies/freezes those inputs and hashes sources, resolutions,
dependencies, entry identity and capture failures.

`analyze()` interprets captured syntax only. It never imports analyzed modules, invokes plugin
factories/hooks/getters, or consults runtime builtin provenance. Its output contains definition
and registration spans (half-open UTF-16), definite/possible references, versioned contracts,
source failures, diagnostics, separate domain coverage and analysis limits/fingerprints.

Supported composition includes immutable constants, explicit imports/exports, simple factory
returns, assertions around descriptors, literal arrays/objects, ordered spreads and finite
branches. Writes/escaping aliases, unsupported control flow, unknown keys, unresolved imports,
cycles and budget exhaustion remain gaps. Equal dependency projections can resolve even when
configuration branches differ. Overwritten dependencies disappear; malformed metadata survives.
The metadata item boundary always requires an unwrapped literal array of literal objects with
one string `entity`, at most one string `field`, and no other syntax/members.

`shippedSummaries` contains nine reviewed leaves bound to exact SDK exports, source bytes,
all 255 shipped implementation/manifest/lock inputs and their resolution graph. The conservative
shared dependency closure intentionally invalidates all leaves on any relevant SDK change.
The analyzer/summary implementation itself is versioned and bound by the candidate commit and
witness implementation hashes; it is excluded from the reviewed plugin dependency closure.
Rebinding requires reviewing dependency/configuration effects and repeating the offline witness;
there is no automatic name/prefix/helper-based approval or production summary generator.
Caller spreads/overrides remain subject to ordinary composition rules.
On-disk fingerprints use a strict `sha256:` tag; decoded digests retain the same exact-byte
binding. Analyzer `snapshot-4` includes fail-closed use paths; summaries remain `sdk-leaves-2`.

Factory alternatives are called separately before comparing dependency projections. Lexical
bindings take precedence over intrinsic `undefined`; both omitted and proven undefined arguments
apply parameter defaults. Falling continuations remain gaps. Captured aliases returned through
functions, arrows or getters inherit their owner's consumer stability; untracked or escaping
owners remain gaps. Immutable factory-local returns are supported. The transitive captured runtime resolution closure is
validated even for modules with no demanded exports, including side-effect imports.
Named and default declaration exports participate in owner/consumer stability. Before
intrinsic `undefined` is allowed, a bounded scan checks every value-binding form, including
nested destructuring, namespace/import-equals bindings, classes/enums/namespaces, catch
parameters and loop heads. Unsupported bindings or an incomplete scan remain unresolved.
Namespace re-exports propagate consumer stability; aliases published by unprojected
class fields, enum members or namespace initialization remain gaps.

Stability uses the closed `publicationStep` vocabulary. Tracked identifiers may pass through
parentheses, assertions, satisfies and non-null wrappers; property reads; object/array literals,
property/shorthand assignments and ordered spreads; finite conditional/logical/equality expressions;
and direct factory callee positions. Every path must terminate at an immutable simple binding
(with its own checked uses), a checked static import/export owner, or a modeled return owner.
Assignment RHS/LHS, call arguments, member calls, class/enum publication, unmodeled parent kinds
and parser kinds opaque to traversal yield gaps. Type-only positions and nonbinding property
keys are inert. Container aliases propagate stability to their default-export consumers.

Only static import/export declarations have modeled consumer edges. Other uses of a captured
module specifier, dynamic imports, import-equals, require and import.meta are unsupported; opaque
loaders conservatively invalidate exported inventories. Consumer scans stop at current source-bound
SDK summary frontiers; stale summaries cannot create a frontier and demanded leaves are always
validated. Unrelated dependency-only SDK tooling is not treated as an instance consumer.
Function-scope var predeclaration recursively covers blocks, if, loops, switch, try/catch/finally
and labeled statements, stopping at nested functions/classes. Unknown scope statements fail
closed before any outer lookup; local lexical declarations are prebound in each interpreted block.
Unusual safe expression statements, assignment aliases and pure-looking argument publication may
now be gaps. Ordinary immutable literal/imported-factory inventories remain precise.

`removal()` reports every matching definite/possible dependency, relevant coverage gap and
source/validation failure. Entity-only references block the entity, without inventing field
dependencies. Contract-only uncertainty stays in its own domain; invalid contract composition
is still reported as a validation failure. A safe result applies to the supplied inventory only.
This S1 module inventories plugins; it does not certify an entire instance before S2 collectors
add policies, executable code, presentation and other sources.

The module is intentionally absent from public package exports and runtime indexes. It provides
no editing, rename/removal execution, Console/MCP/CLI adapter, physical plan or publication flow.
Existing check/access/list behavior is unchanged.

The offline witness is `packages/core/test/infra/reference-snapshot-evidence.ts`. Pass an explicit
evidence output directory when invoking it with Bun. It compares the exact template's nine
registrations with real local factory results without invoking hooks, in an isolated empty-config
fixture. It emits full coverage, referenced/unrelated field/entity controls, all seven historical
site spans, candidate/base SHAs, implementation/source/resolution/dependency hashes and unchanged
input-byte hashes. The template config's placeholders and missing generated artifacts are not
silently accepted as an executable instance: the isolated fixture explicitly supplies `{}`.
