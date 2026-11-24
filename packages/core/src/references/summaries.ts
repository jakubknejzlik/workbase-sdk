import data from './sdk-leaves.json'
import { freeze, type LeafSummary } from './model'

/** Reviewed leaves, not a trust predicate. Every byte and resolution binding is checked by analyze().
 * The nine factories consume options only for configuration/ports. Their SQL migrations own plugin
 * tables, not instance entity/field targets. Generic permission/console hooks consume the effective
 * model; they do not require any particular authored entity/field. No schema target is inferred from
 * a contract name. Caller descriptor overrides are analyzed after the summarized leaf.
 *
 * The conservative closure covers all shipped core/plugin implementation sources, package manifests,
 * and bun.lock. Changing any of them intentionally invalidates these leaves until reviewed/rebound.
 */
export const shippedSummaries: readonly LeafSummary[] = freeze(data.leaves.map(leaf => ({
  ...leaf, provides: Object.fromEntries(Object.entries(leaf.provides)), requires: Object.fromEntries(Object.entries(leaf.requires)), optionalRequires: Object.fromEntries(Object.entries(leaf.optionalRequires)), version: data.version, arguments: 'configuration-only' as const,
  dependencies: data.dependencies, dependencyHash: data.dependencyHash, resolutionHash: data.resolutionHash,
  schemaReferences: [],
})))
