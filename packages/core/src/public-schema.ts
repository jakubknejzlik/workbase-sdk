import { z } from 'zod'
import { labelDependencies } from './query/labels'
import { publicQuery, publicCommands, sanitizeSchema } from './public-projection'
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
      fields: Object.fromEntries(Object.entries(entity.fields).map(([fieldName, field]) => [fieldName, {
        type: field.type, required: field.required,
        ...(field.values === undefined ? {} : { values: field.values }),
        ...(field.entity === undefined ? {} : { entity: field.entity }),
        ...(field.readOnly === undefined ? {} : { readOnly: field.readOnly }),
        ...(field.sensitive === undefined ? {} : { sensitive: field.sensitive }),
        ...(field.ui === undefined ? {} : { ui: field.ui }),
      }])),
    }])),
    query: publicQuery(config),
    policies: Object.fromEntries(Object.entries(config.policies).map(([entity, roles]) => [entity, Object.fromEntries(Object.keys(roles).map(role => [role, true]))])),
    capabilities: { path: '/o/:org/capabilities', authentication: 'required' },
    roles: config.roles, permissions: config.permissions,
    commands: publicCommands(config, options),
    workflows: [...(options.workflows?.values() ?? [])].map(workflow => ({ name: workflow.name, version: workflow.version,
      inputSchema: sanitizeSchema(z.toJSONSchema(workflow.input)),
      permissions: workflow.steps?.map(step => ({ name: step.operation.name, permission: step.operation.permission })),
    })),
  }
}
