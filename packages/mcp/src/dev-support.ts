import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { WorkbasePlugin } from '@workbasehq/core/kernel/plugin'
import type { InstanceConfig } from '@workbasehq/core/config'

/** Trusted operator hook. Never populated from MCP tool arguments or instance data. */
interface DevelopmentModule {
  sources: Record<string, { factory: () => WorkbasePlugin; exported: string; source: string }>
  allowed: string[]
  agentInstance: string
  createAgentInstance(root: string): Promise<string>
  protectedField(config: InstanceConfig, entity: string, field: string, rename: boolean): boolean | undefined
}
const modulePath = process.env.WORKBASE_MCP_DEV_MODULE
export const devFixtures: DevelopmentModule | undefined = modulePath
  ? await import(pathToFileURL(resolve(modulePath)).href) : undefined
