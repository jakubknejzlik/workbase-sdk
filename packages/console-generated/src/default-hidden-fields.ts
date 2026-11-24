import type { Field } from './read'

// Adapter-only provenance, kept outside the wire model and public UI syntax.
// A user-hidden field is never eligible for an explicit-list exception.
const defaultHidden = new WeakSet<Field>()
export function hideFieldByDefault<T extends Field>(field: T): T {
  if (!field.ui?.hidden) defaultHidden.add(field)
  field.ui = { ...field.ui, hidden: true }
  return field
}
export function hiddenField(field: Field | undefined, explicitListColumn = false): boolean {
  return !!field?.ui?.hidden && !(explicitListColumn && defaultHidden.has(field))
}
