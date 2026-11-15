import type { ConsoleModelContract, ConsoleRegistry } from '@workbasehq/core/console-contract'
import type { Model } from '@workbasehq/console-generated/read'
import { coreConsoleContribution } from '../../../core/src/console-contribution'

export interface RuntimeConsole extends Omit<ConsoleModelContract, 'model' | 'console'> { model: Model & ConsoleModelContract['model']; console: ConsoleRegistry }
/** Consume only the authenticated, sanitized projection. Never supplement it from /schema. */
export function adaptConsoleModel(document: ConsoleModelContract): RuntimeConsole {
  if (document.contractVersion !== 1) throw new Error('Unsupported console contract')
  const { model, capabilities } = document
  // A console provider is optional. The packaged console still owns its built-in
  // overview when the server has no contributed registry.
  const homePages = coreConsoleContribution.pages!.filter(page => page.id === 'core.overview')
  const homeNavigation = capabilities.organization.role === 'member' ? [] : coreConsoleContribution.navigation!.filter(item => item.page === 'core.overview')
  const registry: ConsoleRegistry = document.console ?? {
    navigation: [...homeNavigation, ...Object.keys(model.entities).filter(entity => capabilities.entities[entity]?.operations.includes('read') && capabilities.entities[entity].readable.includes('id')).map(entity => ({ id: `entity.${entity}`, entity, label: `entity_${entity}`, placement: 'sidebar' as const }))],
    pages: homePages, entities: {}, modelUi: model.ui,
  }
  // The registry in this document is already sanitized by the contract endpoint.
  const entities = Object.fromEntries(Object.entries(model.entities).map(([name, definition]) => {
    const overlay = registry.entities[name]
    return [name, { ...definition, ...overlay,
      fields: Object.fromEntries(Object.entries(definition.fields).map(([field, spec]) => [field, { ...spec, ui: { ...(overlay?.fields?.[field] ?? spec.ui), ...(['id', 'organization_id', 'created_at', 'updated_at', 'version'].includes(field) ? { hidden: true as const } : {}) } }])),
    }]
  }))
  return { ...document, model: { ...model, entities, limits: model.limits as Model['limits'], commands: model.commands.map(command => ({ ...command, additionalPermissions: [...command.additionalPermissions] })) }, console: registry }
}
