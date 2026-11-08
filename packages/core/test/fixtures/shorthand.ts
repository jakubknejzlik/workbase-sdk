import type { ShorthandInput } from '../../src/config-shorthand'
import sample from './sample/config'
import accounts from './accounts/config'

export const sampleDx: ShorthandInput = { ...sample, entities: { ...sample.entities, clients: { ...sample.entities.clients, fields: { ...sample.entities.clients.fields, name: 'string!' } } } }
export const accountsDx: ShorthandInput = { ...accounts, entities: { ...accounts.entities, users: { ...accounts.entities.users, fields: { ...accounts.entities.users.fields, name: 'string!' } } } }
