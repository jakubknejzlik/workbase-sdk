import { z } from 'zod'
import type { InstanceConfig } from '@workbasehq/core/config'
import type { ConsoleNavigation, ConsolePage } from '@workbasehq/core/console-contract'
import type { ConsoleValidationContext } from '@workbasehq/core/kernel/plugin'
import { consoleCollectionCommand, consoleCommandCreates } from '../../../core/src/console-presentation'

const identifier = z.string().min(1).max(64).regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/)
const caption = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.-]+$/)
const actionSchema = z.strictObject({
  id: identifier, label: caption, description: caption.optional(),
  icon: z.enum(['LayoutDashboard', 'Users', 'MapPin', 'Coins', 'Wallet', 'ArrowLeftRight', 'Settings', 'Building2', 'Activity', 'Workflow', 'Database', 'Folder', 'History']).optional(), primary: z.literal(true).optional(),
  target: z.union([z.strictObject({ navigation: z.string() }), z.strictObject({ create: identifier }),
    z.strictObject({ command: z.string().min(1).max(128).regex(/^[a-z][a-z0-9_]*(\/[a-z][a-z0-9_]*)+$/) })]),
})

/** Validate definitions, never actor authority. The kernel supplies final runtime/plugin overrides. */
export function validatePageActions(config: InstanceConfig, pages: readonly ConsolePage[], navigation: readonly ConsoleNavigation[], context?: ConsoleValidationContext) {
  const configured = config.ui?.navigation
  const entityNavigation = [...(configured?.items ?? []), ...Object.keys(config.entities).filter(entity => !configured?.items.some(item => item.entity === entity)).map(entity => ({ id: entity }))]
  const navigationIds = new Set([...navigation.map(item => item.id), ...entityNavigation.map(item => `entity.${item.id}`)])
  for (const page of pages) {
    if (page.actions === undefined) continue
    const parsed = z.array(actionSchema).max(12).safeParse(page.actions)
    if (!parsed.success) throw new Error(`Invalid console actions: ${page.id}`)
    const actions = parsed.data
    if (new Set(actions.map(action => action.id)).size !== actions.length || actions.length && actions.filter(action => action.primary).length !== 1) throw new Error(`Invalid console action IDs or primary: ${page.id}`)
    for (const action of actions) {
      const target = action.target
      let valid = false
      if ('navigation' in target) valid = navigationIds.has(target.navigation)
      if ('create' in target) {
        const entity = config.entities[target.create]
        valid = !!entity && (!entity.commandsOnly || [...context?.commands.values() ?? []].some(command => config.commands.includes(command.name) && consoleCollectionCommand(config, command, target.create) && consoleCommandCreates(command, target.create)))
      }
      if ('command' in target) {
        const command = context?.commands.get(target.command)
        valid = !!command && config.commands.includes(command.name) && !!consoleCollectionCommand(config, command)
      }
      if (!valid) throw new Error(`Invalid console action target: ${page.id}.${action.id}`)
    }
  }
}
