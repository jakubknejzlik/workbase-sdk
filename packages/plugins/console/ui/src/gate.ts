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
  const readable = (entity: string, field: string) => permission(entity)?.readable?.includes(field) === true
  const writable = (entity: string, field: string) => readable(entity, field) && permission(entity)?.writable?.includes(field) === true
  function allows(page: Pick<Page, 'entity' | 'mode' | 'data' | 'uses'>): boolean {
    function operation(entity: string, mode: Page['mode']) {
      const operations = permission(entity)?.operations ?? []
      return mode === 'create' ? operations.includes('create') : operations.includes('read') && readable(entity, 'id') && (mode !== 'edit' || operations.includes('update'))
    }
    return (!page.entity || operation(page.entity, page.mode)) && Object.values(page.data).every(binding => operation(binding.entity, binding.kind === 'list' ? 'list' : 'detail')) && page.uses.every(use => {
      const [entity, field] = use.split('.')
      return operation(entity, 'detail') && readable(entity, field)
    })
  }
  function metadata(entity: string): EntityMeta {
    const source = own(manifest.entities, entity)
    const fields = Object.fromEntries(Object.entries(source?.fields ?? {}).filter(([field]) => readable(entity, field)))
    return { displayField: source && readable(entity, source.displayField) ? source.displayField : 'id', fields }
  }
  return { allows, readable, writable, metadata, resource: (key: string) => own(caps?.resources, key) === true }
}
/** Reject corrupt boot documents; absent individual grants still mean deny. */
export function parseCapabilities(value: unknown): Capabilities {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const strings = (item: unknown) => Array.isArray(item) && item.every(v => typeof v === 'string')
  if (!object(value) || !Number.isSafeInteger(value.revision) || !object(value.entities) || !object(value.resources) || !object(value.organization) || typeof value.organization.role !== 'string' || !strings(value.commands) || !object(value.workflows)
    || !Object.values(value.resources).every(v => typeof v === 'boolean') || !Object.values(value.workflows).every(strings)
    || !Object.values(value.entities).every(v => object(v) && ['readable', 'writable', 'operations'].every(k => !Object.hasOwn(v, k) || strings(v[k])))) throw new Error('Invalid capabilities')
  return value as Capabilities
}
