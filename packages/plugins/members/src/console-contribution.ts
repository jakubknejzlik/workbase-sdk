import type { ConsoleContribution } from '@workbasehq/core/console-contract'

/** Shared with the packaged console without importing the server plugin. */
export const membersConsoleContribution: ConsoleContribution = {
  pages: [{ id: 'members.list', path: '/settings/workspace-members', label: 'members', grant: 'members.read', renderer: 'members.list' }],
  navigation: [{ id: 'members.list', placement: 'settings', page: 'members.list', label: 'members', order: 30, grant: 'members.read' }],
}
