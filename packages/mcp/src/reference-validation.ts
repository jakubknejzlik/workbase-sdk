import type { RemovalIntent } from '@workbasehq/core/references'
/** Shared read-only check used by Console/CI; no MCP operations or writes. */
export async function validateReferenceSources(root: string, intent?: RemovalIntent) {
  const { validateInstanceReferences } = await import('@workbasehq/plugins/console/ui/check')
  return validateInstanceReferences(root, intent)
}
