import { defineInstance, Fn, Q } from '@workbasehq/core/config'
import { identity } from '@workbasehq/plugins/identity'
import { localAuth } from '@workbasehq/plugins/local-auth'
import { legacyPermissions } from '@workbasehq/plugins/permissions'
import { consoleUI } from '@workbasehq/plugins/console'
import { members } from '@workbasehq/plugins/members'
import { organizations } from '@workbasehq/plugins/organizations'
export const computedConfig = defineInstance({ id: 'computed_fixture', revision: 1, displayName: 'Computed fields', locale: 'cs', interactive: true,
  plugins: [identity, localAuth, organizations, members, legacyPermissions, consoleUI()], roles: ['owner'],
  entities: {
    zakaznik: { displayField: 'jmeno', fields: { jmeno: { type: 'string', required: true } } },
    sluzba: { displayField: 'nazev', fields: { nazev: { type: 'string', required: true } } },
    rezervace: { displayField: Fn.concat('termin', Q.value(' - '), 'zakaznik', Q.value(' - '), 'sluzba').serialize(),
      fields: { termin: { type: 'datetime', required: true }, zakaznik: { type: 'ref', entity: 'zakaznik' }, sluzba: { type: 'ref', entity: 'sluzba' } } },
    poznamka: { displayField: 'text', fields: { text: { type: 'string', required: true }, rezervace: { type: 'ref', entity: 'rezervace' } } },
  },
  permissions: { owner: { zakaznik: 'all', sluzba: 'all', rezervace: 'all', poznamka: 'all' } },
  policies: { zakaznik: { owner: 'all' }, sluzba: { owner: 'all' }, rezervace: { owner: 'all' }, poznamka: { owner: 'all' } },
  enumLabels: { cs: { entity_zakaznik: 'Zákazníci', entitySingular_zakaznik: 'zákazník', entityObject_zakaznik: 'zákazníka', entity_sluzba: 'Služby', entity_rezervace: 'Rezervace', entity_poznamka: 'Poznámky', entitySingular_poznamka: 'poznámku', field_text_poznamka: 'Text', field_rezervace_poznamka: 'Rezervace', field_termin_rezervace: 'Termín' } },
  ui: { entities: { rezervace: { list: { columns: ['computed_display', 'termin', 'zakaznik', 'sluzba'] } } } },
})
