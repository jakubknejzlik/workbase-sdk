import type { ConsoleGrant, ConsoleModelContract, ConsoleRegistry } from '@workbasehq/core/console-contract'
import type { Model } from '@workbasehq/console-generated/read'
import { hideFieldByDefault } from '../../../console-generated/src/default-hidden-fields'
import { coreConsoleContribution } from '../../../core/src/console-contribution'
import { membersConsoleContribution } from '../../../plugins/members/src/console-contribution'

export interface RuntimeConsole extends Omit<ConsoleModelContract, 'model' | 'console'> { model: Model & ConsoleModelContract['model']; console: ConsoleRegistry }

function fallbackRegistry({ model, capabilities }: ConsoleModelContract): ConsoleRegistry {
  const role = capabilities.organization.role
  const permits = (grant?: ConsoleGrant) => !grant || (typeof grant === 'string' ? capabilities.resources[grant] === true : capabilities.entities[grant.entity]?.operations.includes(grant.operation ?? 'read'))
  // Keep the packaged built-ins eligible through the same grants as their links.
  const pages = [...coreConsoleContribution.pages!.filter(page => page.id === 'core.overview'), ...membersConsoleContribution.pages!].filter(page => permits(page.grant))
  const navigation = [...coreConsoleContribution.navigation!.filter(item => item.page === 'core.overview'), ...membersConsoleContribution.navigation!].filter(item =>
    // Mirror the server registry's intentional member navigation exclusion.
    (role !== 'member' || item.placement === 'sidebar' && !!item.entity)
    // Members navigation also requires an established, non-empty role string.
    && (item.page !== 'members.list' || typeof role === 'string' && role.trim().length > 0)
    && permits(item.grant) && (!item.roles || item.roles.includes(role)) && pages.some(page => page.id === item.page))
  return {
    navigation: [...navigation, ...Object.keys(model.entities).filter(entity => capabilities.entities[entity]?.operations.includes('read') && capabilities.entities[entity].readable.includes('id')).map(entity => ({ id: `entity.${entity}`, entity, label: `entity_${entity}`, placement: 'sidebar' as const }))],
    pages, entities: {}, modelUi: model.ui,
  }
}

/** Consume only the authenticated, sanitized projection. Never supplement it from /schema. */
export function adaptConsoleModel(document: ConsoleModelContract): RuntimeConsole {
  if (document.contractVersion !== 2) throw new Error('Unsupported console contract')
  const { model } = document
  // A console provider is optional. The packaged console still owns its built-in
  // overview and authorized Members page when the server has no contributed registry.
  const registry = document.console ?? fallbackRegistry(document)
  // The registry in this document is already sanitized by the contract endpoint.
  const entities = Object.fromEntries(Object.entries(model.entities).map(([name, definition]) => {
    const overlay = registry.entities[name]
    return [name, { ...definition, ...overlay,
      fields: Object.fromEntries(Object.entries(definition.fields).map(([field, spec]) => {
        const adapted = { ...spec, ui: { ...(overlay?.fields?.[field] ?? spec.ui) } }
        if (['id', 'organization_id', 'created_at', 'updated_at', 'version'].includes(field)) {
          // Preserve declared hiding even when another registry hint replaces UI metadata.
          if (spec.ui?.hidden) adapted.ui.hidden = true
          hideFieldByDefault(adapted)
        }
        return [field, adapted]
      })),
    }]
  }))
  return { ...document, model: { ...model, entities, limits: model.limits as Model['limits'], commands: model.commands.map(command => ({ ...command, additionalPermissions: [...command.additionalPermissions] })) }, console: registry }
}
