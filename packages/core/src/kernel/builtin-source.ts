import type { WorkbasePlugin } from './plugin'

// tsImport loads isolated module copies in one realm. Keep provenance across
// those copies without accepting names, structural lookalikes or copied hooks.
const key = Symbol.for('workbase.builtin-plugin-sources')
const shared = globalThis as unknown as Record<symbol, WeakSet<object>>
const sources = shared[key] ??= new WeakSet<object>()
export function builtinPlugin(plugin: WorkbasePlugin): WorkbasePlugin {
  // Canonical source cannot describe contributions that callers can replace in
  // place. Freeze plain descriptor data, leaving Zod instances/lazy caches alone.
  const seen = new WeakSet<object>()
  const freezeData = (value: unknown): void => {
    if (!value || typeof value !== 'object' || seen.has(value)) return
    const prototype = Object.getPrototypeOf(value)
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return
    seen.add(value)
    for (const child of Object.values(value)) freezeData(child)
    Object.freeze(value)
  }
  freezeData(plugin.contributes)
  freezeData(plugin.model)
  freezeData(plugin.commands)
  freezeData(plugin.workflows)
  // Zod populates lazy method caches; only descriptor data is frozen.
  for (const key of ['provides', 'requires', 'optionalRequires', 'migrations'] as const) {
    const value = plugin[key]
    if (key === 'migrations') for (const migration of plugin.migrations ?? []) Object.freeze(migration)
    if (value) Object.freeze(value)
  }
  Object.freeze(plugin)
  sources.add(plugin)
  return plugin
}
export function isBuiltinPlugin(plugin: WorkbasePlugin): boolean { return sources.has(plugin) }
