import { defineInstance } from '@workbasehq/core/config'
import { createIdentity as identity } from '@workbasehq/plugins/identity'
import { permissions } from '@workbasehq/plugins/permissions'
import { createMembers as members } from '@workbasehq/plugins/members'
import { createOrganizations as organizations } from '@workbasehq/plugins/organizations'
import { createLocalAuth as localAuth } from '@workbasehq/plugins/local-auth'
import { machineCredentials } from '@workbasehq/plugins/machine-credentials'
import { mailOutbox } from '@workbasehq/plugins/mail-outbox'
import { audit } from '@workbasehq/plugins/audit'
import { consoleUI } from '@workbasehq/plugins/console'
export default defineInstance({
  plugins: [identity({"trustedIssuers":{}}), permissions({"roles":["owner","viewer"],"ownerRole":"owner"}), members(), organizations({"allowCreate":true}), localAuth({"methods":["magic-link"]}), machineCredentials(), mailOutbox(), audit(), consoleUI()],
  "interactive": true,
  "locale": "en",
  "timeZone": "UTC",
  "registration": "open",
  "organizationOwnerRole": "owner",
  "displayName": "Workbase test",
  "id": "workbase_test",
  "revision": 3,
  "entities": {
    "zakaznik": {
      "fields": {
        "jmeno": {
          "type": "string",
          "required": true
        },
        "email": {
          "type": "string",
          "required": false
        },
        "telefon": {
          "type": "string",
          "required": false
        },
        "adresa": {
          "type": "string",
          "required": false
        },
        "poznamka": {
          "type": "text",
          "required": false
        }
      },
      "relations": {},
      "checks": []
    },
    "sluzba": {
      "fields": {
        "nazev": {
          "type": "string",
          "required": true
        },
        "popis": {
          "type": "text",
          "required": false
        },
        "cena": {
          "type": "float",
          "required": true
        },
        "delka_minut": {
          "type": "int",
          "required": false
        },
        "aktivni": {
          "type": "bool",
          "required": false,
          "default": true
        }
      },
      "relations": {},
      "checks": []
    },
    "uklizecka": {
      "fields": {
        "jmeno": {
          "type": "string",
          "required": true
        },
        "email": {
          "type": "string",
          "required": false
        },
        "telefon": {
          "type": "string",
          "required": false
        },
        "aktivni": {
          "type": "bool",
          "required": false,
          "default": true
        }
      },
      "relations": {},
      "checks": []
    },
    "dostupnost": {
      "fields": {
        "uklizecka": {
          "type": "ref",
          "required": true,
          "entity": "uklizecka"
        },
        "od": {
          "type": "datetime",
          "required": true
        },
        "do": {
          "type": "datetime",
          "required": true
        },
        "poznamka": {
          "type": "string",
          "required": false
        }
      },
      "relations": {},
      "checks": []
    },
    "rezervace": {
      "fields": {
        "zakaznik": {
          "type": "ref",
          "required": true,
          "entity": "zakaznik"
        },
        "sluzba": {
          "type": "ref",
          "required": true,
          "entity": "sluzba"
        },
        "uklizecka": {
          "type": "ref",
          "required": false,
          "entity": "uklizecka"
        },
        "termin": {
          "type": "datetime",
          "required": true
        },
        "adresa": {
          "type": "string",
          "required": false
        },
        "cena": {
          "type": "float",
          "required": false
        },
        "stav": {
          "type": "enum",
          "required": true,
          "values": [
            "nova",
            "potvrzena",
            "hotova",
            "zrusena"
          ],
          "default": "nova"
        },
        "poznamka": {
          "type": "text",
          "required": false
        }
      },
      "relations": {},
      "checks": []
    },
    "ukol": {
      "fields": {
        "rezervace": {
          "type": "ref",
          "required": true,
          "entity": "rezervace"
        },
        "nazev": {
          "type": "string",
          "required": true
        },
        "hotovo": {
          "type": "bool",
          "required": false,
          "default": false
        },
        "poradi": {
          "type": "int",
          "required": false
        }
      },
      "relations": {},
      "checks": []
    },
    "skoda": {
      "fields": {
        "rezervace": {
          "type": "ref",
          "required": true,
          "entity": "rezervace"
        },
        "popis": {
          "type": "text",
          "required": true
        },
        "castka": {
          "type": "float",
          "required": false
        },
        "zapsano": {
          "type": "datetime",
          "required": false
        }
      },
      "relations": {},
      "checks": []
    }
  },
  "roles": [
    "owner",
    "viewer"
  ],
  "policies": {
    "zakaznik": {
      "owner": "all"
    },
    "sluzba": {
      "owner": "all"
    },
    "uklizecka": {
      "owner": "all"
    },
    "dostupnost": {
      "owner": "all"
    },
    "rezervace": {
      "owner": "all"
    },
    "ukol": {
      "owner": "all"
    },
    "skoda": {
      "owner": "all"
    }
  },
  "permissions": {
    "owner": {
      "zakaznik": [
        "read",
        "create",
        "update",
        "delete"
      ],
      "sluzba": [
        "read",
        "create",
        "update",
        "delete"
      ],
      "uklizecka": [
        "read",
        "create",
        "update",
        "delete"
      ],
      "dostupnost": [
        "read",
        "create",
        "update",
        "delete"
      ],
      "rezervace": [
        "read",
        "create",
        "update",
        "delete"
      ],
      "ukol": [
        "read",
        "create",
        "update",
        "delete"
      ],
      "skoda": [
        "read",
        "create",
        "update",
        "delete"
      ]
    },
    "viewer": {
      "zakaznik": [],
      "sluzba": [],
      "uklizecka": [],
      "dostupnost": [],
      "rezervace": [],
      "ukol": [],
      "skoda": []
    }
  },
  "commands": [],
  "organizationPermissions": {
    "owner": [
      "organizations.update",
      "members.read",
      "members.update",
      "members.remove",
      "invitations.create",
      "invitations.read",
      "invitations.revoke",
      "tokens.create",
      "tokens.read",
      "tokens.revoke"
    ],
    "viewer": []
  }
})
