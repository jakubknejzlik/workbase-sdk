import { z } from 'zod'
import { labelDependencies } from './query/labels'
import { publicQuery, publicCommands, publicFields, publicPolicies, sanitizeSchema } from './public-projection'
import type { InstanceConfig } from './config'
import type { RuntimeOptions } from './types'

/** Anonymous build metadata: explicit entity projection, sanitized input schemas. */
export function publicSchema(config: InstanceConfig, options: RuntimeOptions) {
  return {
    instance: config.id, revision: config.revision,
    ...(config.displayName ? { displayName: config.displayName } : {}),
    ...(config.ui ? { ui: config.ui } : {}),
    entities: Object.fromEntries(Object.entries(config.entities).map(([name, entity]) => [name, {
      ...(entity.displayField ? { displayField: entity.displayField } : {}),
      ...(entity.label ? { labelDependencies: labelDependencies(config, name) } : {}),
      fields: publicFields(entity),
    }])),
    query: publicQuery(config),
    policies: publicPolicies(config),
    capabilities: { path: '/o/:org/capabilities', authentication: 'required' },
    roles: config.roles, permissions: config.permissions,
    commands: publicCommands(config, options, true),
    workflows: [...(options.workflows?.values() ?? [])].map(workflow => ({ name: workflow.name, version: workflow.version,
      inputSchema: sanitizeSchema(z.toJSONSchema(workflow.input)),
      permissions: workflow.steps?.map(step => ({ name: step.operation.name, permission: step.operation.permission })),
    })),
  }
}
