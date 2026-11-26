import { defineInstance } from '@workbasehq/core'
import { neutralConfig } from './config'

// Neutral member/pass configuration shapes. Uses only existing presentation hints;
// consumer acceptance and route-aware panels remain separate integration work.
const base = neutralConfig(true)
export const detailInformationConfig = defineInstance({ ...base, languages: ['en', 'cs'], timeZone: 'Europe/Prague',
  entities: {
    specimens: { ...base.entities.specimens, fields: { ...base.entities.specimens.fields,
      name: { ...base.entities.specimens.fields.name, ui: { span: 'half' } },
      note: { ...base.entities.specimens.fields.note, ui: { span: 'full' } },
      enabled: { type: 'bool', default: false }, state: { type: 'enum', values: ['active', 'inactive'] },
      parent_id: { type: 'ref', entity: 'containers', ui: { span: 'half' } },
    }, relations: { parent: { entity: 'containers', field: 'parent_id' } } },
    containers: { ...base.entities.containers, fields: { ...base.entities.containers.fields,
      quantity: { type: 'int' }, state: { type: 'enum', values: ['active', 'inactive'] },
      note: { type: 'text' }, enabled: { type: 'bool', default: false },
      specimen_id: { type: 'ref', entity: 'specimens' },
    }, relations: { specimen: { entity: 'specimens', field: 'specimen_id' } } },
    folders: { displayField: 'name', fields: { name: { type: 'string', required: true }, note: { type: 'text' } } },
  },
  permissions: { owner: { specimens: ['read', 'create', 'update', 'delete'], containers: ['read', 'create', 'update', 'delete'], folders: ['read'] }, viewer: { specimens: ['read'], containers: ['read'], folders: ['read'] } },
  policies: {
    specimens: { owner: 'all', viewer: { where: {}, fields: ['name', 'note', 'quantity', 'state', 'parent_id'] } },
    containers: { owner: 'all', viewer: { where: {}, fields: ['label', 'note', 'quantity', 'state', 'specimen_id'] } },
    folders: { owner: 'all', viewer: 'all' },
  },
  enumLabels: {
    en: { entity_specimens: 'Members', entity_containers: 'Passes', entity_folders: 'Archive',
      entitySingular_specimens: 'Member information', entitySingular_containers: 'Pass information',
      field_name_specimens: 'Full name', field_parent_id_specimens: 'Related record', field_specimen_id_containers: 'Assigned member',
      field_note_specimens: 'Additional registration information', field_note_containers: 'Additional registration information',
      field_quantity_specimens: 'Available entries', field_quantity_containers: 'Available entries', field_state_containers: 'Status',
      value_active: 'Active', value_inactive: 'Inactive',
    },
    cs: { entity_specimens: 'Členové', entity_containers: 'Vydané karty', entity_folders: 'Archiv',
      entitySingular_specimens: 'Údaje o členovi', entitySingular_containers: 'Informace o kartě',
      field_name_specimens: 'Celé jméno', field_parent_id_specimens: 'Přiřazený záznam', field_specimen_id_containers: 'Přiřazený člen',
      field_note_specimens: 'Doplňující údaje pro původní registraci a následné ověření členství v organizaci',
      field_note_containers: 'Doplňující údaje pro původní registraci a následné ověření členství v organizaci',
      field_quantity_specimens: 'Počet zbývajících vstupů', field_quantity_containers: 'Počet zbývajících vstupů', field_state_containers: 'Stav',
      value_active: 'Aktivní', value_inactive: 'Neaktivní',
    },
  },
  ui: { entities: {
    specimens: {
      form: { edit: { fields: ['name', 'parent_id', 'note'] } },
      sections: [{ id: 'contact', label: 'entitySingular_specimens', fields: ['name', 'parent_id', 'note'] }],
      detail: { inlineEdit: true, summary: [], groups: [{ id: 'member', label: 'entitySingular_specimens', help: 'detailInformationHelp', fields: [
        'name', 'parent_id',
        'quantity',
        { field: 'note', help: 'detailConditionalHelp', when: { field: 'enabled', eq: false } },
      ] }], sections: [{ fields: 'info' }] },
    },
    containers: { detail: { summary: ['quantity', { field: 'state', label: 'field_state' }],
      groups: [{ id: 'pass', label: 'entitySingular_containers', help: 'detailInformationHelp', fields: [
        'specimen_id',
        { field: 'note', help: 'detailConditionalHelp', when: { field: 'enabled', eq: false } },
      ] }], sections: [{ fields: 'info' }] } },
    folders: { detail: { fields: ['name', 'note'], sections: [{ fields: 'info' }] } },
  } },
})
