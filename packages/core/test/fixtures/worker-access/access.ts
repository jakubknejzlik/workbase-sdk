import { defineAccess } from '@workbasehq/core/schema'
export default defineAccess({
  "accountLinks": {
    "worker": {
      "invitationRole": "staff"
    }
  },
  "predicates": {},
  "roles": {
    "admin": {
      "system": {
        "audit.read": "allow",
        "invitations.accept": "allow",
        "invitations.create": "allow",
        "invitations.read": "allow",
        "invitations.revoke": "allow",
        "members.leave": "allow",
        "members.read": "allow",
        "members.remove": "allow",
        "members.update": "allow",
        "organizations.create": "allow",
        "organizations.update": "allow",
        "tokens.create": "allow",
        "tokens.read": "allow",
        "tokens.revoke": "allow",
        "workflows.cancel": "allow",
        "workflows.read": "allow",
        "workflows.resume": "allow"
      }
    },
    "staff": {
      "system": {
        "audit.read": "deny",
        "invitations.accept": "allow",
        "invitations.create": "deny",
        "invitations.read": "deny",
        "invitations.revoke": "deny",
        "members.leave": "deny",
        "members.read": "deny",
        "members.remove": "deny",
        "members.update": "deny",
        "organizations.create": "deny",
        "organizations.update": "deny",
        "tokens.create": "deny",
        "tokens.read": "deny",
        "tokens.revoke": "deny",
        "workflows.cancel": "deny",
        "workflows.read": "deny",
        "workflows.resume": "deny"
      }
    }
  },
  "entities": {
    "_migrations": {
      "admin": {
        "read": "allow",
        "create": "allow",
        "update": "allow",
        "delete": "allow"
      },
      "staff": {
        "read": "deny",
        "create": "deny",
        "update": "deny",
        "delete": "deny"
      }
    },
    "_ops_relay_run": {
      "admin": {
        "read": "allow",
        "create": "allow",
        "update": "allow",
        "delete": "allow"
      },
      "staff": {
        "read": "deny",
        "create": "deny",
        "update": "deny",
        "delete": "deny"
      }
    },
    "_plugin_migrations": {
      "admin": {
        "read": "allow",
        "create": "allow",
        "update": "allow",
        "delete": "allow"
      },
      "staff": {
        "read": "deny",
        "create": "deny",
        "update": "deny",
        "delete": "deny"
      }
    },
    "access_tokens": {
      "admin": {
        "read": "allow",
        "create": "allow",
        "update": "allow",
        "delete": "allow"
      },
      "staff": {
        "read": "deny",
        "create": "deny",
        "update": "deny",
        "delete": "deny"
      }
    },
    "account": {
      "admin": {
        "read": "allow",
        "create": "allow",
        "update": "allow",
        "delete": "allow"
      },
      "staff": {
        "read": "deny",
        "create": "deny",
        "update": "deny",
        "delete": "deny"
      }
    },
    "atomic_assert": {
      "admin": {
        "read": "allow",
        "create": "allow",
        "update": "allow",
        "delete": "allow"
      },
      "staff": {
        "read": "deny",
        "create": "deny",
        "update": "deny",
        "delete": "deny"
      }
    },
    "audit_events": {
      "admin": {
        "read": "allow",
        "create": "allow",
        "update": "allow",
        "delete": "allow"
      },
      "staff": {
        "read": "deny",
        "create": "deny",
        "update": "deny",
        "delete": "deny"
      }
    },
    "audit_outbox": {
      "admin": {
        "read": "allow",
        "create": "allow",
        "update": "allow",
        "delete": "allow"
      },
      "staff": {
        "read": "deny",
        "create": "deny",
        "update": "deny",
        "delete": "deny"
      }
    },
    "d1_migrations": {
      "admin": {
        "read": "allow",
        "create": "allow",
        "update": "allow",
        "delete": "allow"
      },
      "staff": {
        "read": "deny",
        "create": "deny",
        "update": "deny",
        "delete": "deny"
      }
    },
    "email_outbox": {
      "admin": {
        "read": "allow",
        "create": "allow",
        "update": "allow",
        "delete": "allow"
      },
      "staff": {
        "read": "deny",
        "create": "deny",
        "update": "deny",
        "delete": "deny"
      }
    },
    "idempotency_keys": {
      "admin": {
        "read": "allow",
        "create": "allow",
        "update": "allow",
        "delete": "allow"
      },
      "staff": {
        "read": "deny",
        "create": "deny",
        "update": "deny",
        "delete": "deny"
      }
    },
    "identities": {
      "admin": {
        "read": "allow",
        "create": "allow",
        "update": "allow",
        "delete": "allow"
      },
      "staff": {
        "read": "deny",
        "create": "deny",
        "update": "deny",
        "delete": "deny"
      }
    },
    "identity_link_grants": {
      "admin": {
        "read": "allow",
        "create": "allow",
        "update": "allow",
        "delete": "allow"
      },
      "staff": {
        "read": "deny",
        "create": "deny",
        "update": "deny",
        "delete": "deny"
      }
    },
    "identity_profiles": {
      "admin": {
        "read": "allow",
        "create": "allow",
        "update": "allow",
        "delete": "allow"
      },
      "staff": {
        "read": "deny",
        "create": "deny",
        "update": "deny",
        "delete": "deny"
      }
    },
    "instance_meta": {
      "admin": {
        "read": "allow",
        "create": "allow",
        "update": "allow",
        "delete": "allow"
      },
      "staff": {
        "read": "deny",
        "create": "deny",
        "update": "deny",
        "delete": "deny"
      }
    },
    "invitations": {
      "admin": {
        "read": "allow",
        "create": "allow",
        "update": "allow",
        "delete": "allow"
      },
      "staff": {
        "read": "deny",
        "create": "allow",
        "update": "deny",
        "delete": "deny"
      }
    },
    "memberships": {
      "admin": {
        "read": "allow",
        "create": "allow",
        "update": "allow",
        "delete": "allow"
      },
      "staff": {
        "read": "deny",
        "create": "deny",
        "update": "deny",
        "delete": "deny"
      }
    },
    "organization_scopes": {
      "admin": {
        "read": "allow",
        "create": "allow",
        "update": "allow",
        "delete": "allow"
      },
      "staff": {
        "read": "deny",
        "create": "deny",
        "update": "deny",
        "delete": "deny"
      }
    },
    "organizations": {
      "admin": {
        "read": "allow",
        "create": "allow",
        "update": "allow",
        "delete": "allow"
      },
      "staff": {
        "read": "deny",
        "create": "deny",
        "update": "deny",
        "delete": "deny"
      }
    },
    "rateLimit": {
      "admin": {
        "read": "allow",
        "create": "allow",
        "update": "allow",
        "delete": "allow"
      },
      "staff": {
        "read": "deny",
        "create": "deny",
        "update": "deny",
        "delete": "deny"
      }
    },
    "security_log": {
      "admin": {
        "read": "allow",
        "create": "allow",
        "update": "allow",
        "delete": "allow"
      },
      "staff": {
        "read": "deny",
        "create": "deny",
        "update": "deny",
        "delete": "deny"
      }
    },
    "session": {
      "admin": {
        "read": "allow",
        "create": "allow",
        "update": "allow",
        "delete": "allow"
      },
      "staff": {
        "read": "deny",
        "create": "deny",
        "update": "deny",
        "delete": "deny"
      }
    },
    "sessions": {
      "admin": {
        "read": "allow",
        "create": "allow",
        "update": "allow",
        "delete": "allow"
      },
      "staff": {
        "read": "deny",
        "create": "deny",
        "update": "deny",
        "delete": "deny"
      }
    },
    "user": {
      "admin": {
        "read": "allow",
        "create": "allow",
        "update": "allow",
        "delete": "allow"
      },
      "staff": {
        "read": "deny",
        "create": "deny",
        "update": "deny",
        "delete": "deny"
      }
    },
    "users": {
      "admin": {
        "read": "allow",
        "create": "allow",
        "update": "allow",
        "delete": "allow"
      },
      "staff": {
        "read": "deny",
        "create": "deny",
        "update": "deny",
        "delete": "deny"
      }
    },
    "verification": {
      "admin": {
        "read": "allow",
        "create": "allow",
        "update": "allow",
        "delete": "allow"
      },
      "staff": {
        "read": "deny",
        "create": "deny",
        "update": "deny",
        "delete": "deny"
      }
    },
    "webhook_deliveries": {
      "admin": {
        "read": "allow",
        "create": "allow",
        "update": "allow",
        "delete": "allow"
      },
      "staff": {
        "read": "deny",
        "create": "deny",
        "update": "deny",
        "delete": "deny"
      }
    },
    "workflow_holds": {
      "admin": {
        "read": "allow",
        "create": "allow",
        "update": "allow",
        "delete": "allow"
      },
      "staff": {
        "read": "deny",
        "create": "deny",
        "update": "deny",
        "delete": "deny"
      }
    },
    "workflow_runs": {
      "admin": {
        "read": "allow",
        "create": "allow",
        "update": "allow",
        "delete": "allow"
      },
      "staff": {
        "read": "deny",
        "create": "deny",
        "update": "deny",
        "delete": "deny"
      }
    },
    "workflow_steps": {
      "admin": {
        "read": "allow",
        "create": "allow",
        "update": "allow",
        "delete": "allow"
      },
      "staff": {
        "read": "deny",
        "create": "deny",
        "update": "deny",
        "delete": "deny"
      }
    }
  }
})
