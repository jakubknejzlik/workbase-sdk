import { GeneratedListCell } from './list-cell'
import { readableListField } from './list-presentation'
import type { Capabilities, Model } from './read'

/** Detail identity is explicit presentation, independent of the collection's columns. */
export function GeneratedDetailIdentity({ model, caps, entity, orgId, row, label }: {
  model: Model; caps: Capabilities; entity: string; orgId: string; row: Record<string, any>; label: string
}) {
  const column = { field: 'id', cell: { kind: 'identifier' as const, copy: true } }
  // Scope the existing cell's explicit-metadata handling to this one ID. Keep
  // original field hiding/provenance and live grants; never use this view for reads.
  const definition = model.entities[entity]
  const presentation: Model = { ...model, entities: { ...model.entities, [entity]: {
    ...definition, list: { ...definition.list, columns: [column] },
  } } }
  if (row.id == null || !readableListField(presentation, entity, caps, 'id')) return null
  return <dl className="generated-detail-identity"><dt>{label}</dt><dd>
    <GeneratedListCell key={String(row.id)} model={presentation} entity={entity} caps={caps} row={row} column={column} orgId={orgId} primary={false} signed={(_row, _field, value) => value} />
  </dd></dl>
}
