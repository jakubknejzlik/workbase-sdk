import { consolePage } from '@workbasehq/core/console-page'
import type { EntityMeta } from './client'
import type { Manifest } from './check'
import type { Page } from './index'

export type Capabilities = {
  revision: number
  entities: Record<string, { readable?: string[]; writable?: string[]; operations?: string[] }>
  resources: Record<string, boolean>
  organization: { role: string }
  commands: string[]
  workflows: Record<string, string[]>
}
const own = <T>(object: Record<string, T> | undefined, key: string): T | undefined => object && Object.hasOwn(object, key) ? object[key] : undefined
/** This projection controls presentation only. The server authorizes every request. */
export function gate(caps: Capabilities | undefined, manifest: Pick<Manifest, 'entities'>) {
  const permission = (entity: string) => own(caps?.entities, entity)
  const readable = (entity: string, field: string) => permission(entity)?.operations?.includes('read') === true && permission(entity)?.readable?.includes('id') === true && permission(entity)?.readable?.includes(field) === true
  const writable = (entity: string, field: string, action: 'create' | 'update' = 'update') => permission(entity)?.operations?.includes(action) === true && (action === 'create' || readable(entity, field)) && permission(entity)?.writable?.includes(field) === true
  const allows = (page: Pick<Page, 'grant' | 'entity' | 'mode' | 'data' | 'uses'>) => consolePage(caps, page)
  function metadata(entity: string, mode?: Page['mode']): EntityMeta {
    const source = own(manifest.entities, entity)
    const fields = Object.fromEntries(Object.entries(source?.fields ?? {}).filter(([field]) => mode === 'create' ? writable(entity, field, 'create') : readable(entity, field)))
    return { displayField: source && readable(entity, source.displayField) ? source.displayField : 'id', fields }
  }
  return { allows, readable, writable, metadata, resource: (key: string) => own(caps?.resources, key) === true }
}
export { parseCapabilities } from '@workbasehq/core/console-page'
