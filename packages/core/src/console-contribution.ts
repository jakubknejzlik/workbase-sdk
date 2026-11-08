import type { ConsoleContribution } from './console-contract'

/** Execution and its built-in administration remain owned by core (ADR 0002). */
export const coreConsoleContribution: ConsoleContribution = {
  pages: [{ id: 'core.overview', path: '/', label: 'overview', renderer: 'core.overview' }, { id: 'core.workflows', path: '/settings/workflows', label: 'workflowRuns', grant: 'workflows.read', renderer: 'core.workflows' }],
  navigation: [{ id: 'core.overview', placement: 'sidebar', page: 'core.overview', label: 'overview', icon: 'LayoutDashboard', order: 0 }, { id: 'core.workflows', placement: 'settings', page: 'core.workflows', label: 'workflowRuns', icon: 'Workflow', order: 50, group: { id: 'operations', label: 'settingsOperations', order: 100 }, grant: 'workflows.read' }],
}
