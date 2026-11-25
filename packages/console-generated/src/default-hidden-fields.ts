import type { Field } from './read'

// Adapter-only metadata, outside the wire contract and public UI syntax.
// Keep it enumerable and serializable: the runtime query cache structurally
// shares fields, so neither object identity nor a Symbol can retain provenance.
type AdaptedField = Field & { __consoleDefaultHidden?: boolean }
export function hideFieldByDefault<T extends Field>(field: T): T {
  // Always derive from declared hiding before applying the adapter default.
  // A user-hidden field is never eligible for an explicit-list exception.
  const adapted: AdaptedField = field
  adapted.__consoleDefaultHidden = !field.ui?.hidden
  field.ui = { ...field.ui, hidden: true }
  return field
}
export function hiddenField(field: Field | undefined, explicitListColumn = false): boolean {
  return !!field?.ui?.hidden && !(explicitListColumn && (field as AdaptedField).__consoleDefaultHidden === true)
}
