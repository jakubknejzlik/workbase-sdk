import { defineInstance, Fn, type InstanceConfig } from '@workbasehq/core/config'
import { initialSchema } from '@workbasehq/core/migrations/schema'
import { builtinPlugin } from '@workbasehq/core/kernel/builtin-source'
import base from '../../../core/test/fixtures/sample/config'
import secondaryBase from '../../../core/test/fixtures/sample/secondary'
import { commands, secondaryCommands, quaternaryCommands, workflow } from './operations'
import { consoleUI } from '@workbasehq/plugins/console'

// Reuse the SDK's neutral relational graph; no instance implementation is loaded.
const entities = { ...base.entities, clients: { ...base.entities.clients, fields: { ...base.entities.clients.fields, status: { type: 'enum' as const, values: ['confirmed', 'cancelled'] } }, constraints: [{ kind: 'unique' as const, name: 'client_identity_unique', fields: ['name', 'email'] }, { kind: 'unique' as const, name: 'client_confirmed_name_unique', fields: ['name'], where: { field: 'status', op: 'eq' as const, value: 'confirmed' } }] } }
const model = { entities, commands: commands.map(command => command.name) }
const secondaryModel = { entities: secondaryBase.entities, commands: secondaryCommands.map(command => command.name) }
const quaternaryModel = { ...model, commands: quaternaryCommands.map(command => command.name) }
export const samplePlugin = () => builtinPlugin({ name: 'sample', version: '0.1.0', model, commands, workflows: [workflow] })
export const secondaryPlugin = () => builtinPlugin({ name: 'secondary', version: '0.1.0', model: secondaryModel, commands: secondaryCommands })
export const tertiaryPlugin = () => builtinPlugin({ name: 'tertiary', version: '0.1.0', model, commands, workflows: [workflow] })
export const quaternaryPlugin = () => builtinPlugin({ name: 'quaternary', version: '0.1.0', model: quaternaryModel, commands: quaternaryCommands, workflows: [workflow] })
const plugins = base.plugins!.map(plugin => plugin.name === 'console' ? consoleUI() : plugin)
export const sample = defineInstance({ ...base, plugins: [...plugins, samplePlugin()], entities: model.entities, commands: model.commands })
export const secondary = defineInstance({ ...secondaryBase, plugins: [...plugins, secondaryPlugin()],
  entities: { ...secondaryBase.entities, tasks: { ...secondaryBase.entities.tasks, relations: { client: { entity: 'clients', field: 'client_id' } } } },
  commands: secondaryModel.commands,
})
export const tertiary = defineInstance({ ...base, id: 'tertiary', plugins: [...plugins, tertiaryPlugin()], commands: model.commands })
export const quaternary = defineInstance({ ...base, id: 'quaternary', ui: { entities: { jobs: { list: { columns: ['title'] } } } }, plugins: [...plugins, quaternaryPlugin()], entities: { ...model.entities, entries: { displayField: 'display_name', label: Fn.concat('name'), fields: { name: { type: 'string', required: true }, display_name: { type: 'string', readOnly: true } } } }, commands: quaternaryModel.commands })
export const historical = defineInstance({ ...sample, revision: 2 })
export const migrations = (config: InstanceConfig) => [{ name: '0001_initial.sql', sql: initialSchema(config) }]
