import { useRuntimeModel } from './runtime-model'
export type { ConsoleRegistry, ConsoleNavigation, ConsolePage } from '@workbasehq/plugins/console/contract'
export function useConsoleRegistry(orgId?: string) {
  const result = useRuntimeModel(orgId)
  return { ...result, data: result.error ? undefined : result.data?.console }
}
