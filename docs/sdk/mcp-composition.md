# Authoring V3 plugin composition through MCP

Use `propose_composition` to add built-in plugins, replace their options, or set
interactive login in a canonical V3 `runtime.ts`. Inspect the instance first,
then propose at its current schema revision:

```json
{
  "instance": "my-instance",
  "baseRevision": 1,
  "changes": [
    { "kind": "set_plugin", "plugin": "organizations", "options": { "allowCreate": true } },
    { "kind": "set_plugin", "plugin": "local-auth", "options": { "methods": ["magic-link"] } },
    { "kind": "set_plugin", "plugin": "mail-outbox" },
    { "kind": "set_interactive", "interactive": true }
  ]
}
```

Follow `validate({proposalId})` → `preview_migration({proposalId})` →
`apply_to_disposable({proposalId})` → `promote({proposalId,expectedRevision:1})`.
The stored proposal kind is `composition_change`. Validation checks the target
kernel, including required providers and interactive login. Disposable
verification runs the SDK/plugin migration engine and committed domain history
on fresh local D1. Any change to tracked application inputs or dependencies
requires validation and verification again.

The preview contains the exact proposed `runtime.ts` bytes and `sql: ""`.
Composition changes retain the domain revision: promotion writes only
`runtime.ts` and proposal metadata. Config, schema declarations and lock, access,
version archives, package/lock files and existing migrations keep their bytes.
SDK-owned plugin baselines run when the operator deploys through the normal
instance migration engine. Promotion itself does not apply a live database
migration, install dependencies, send mail, or configure an email provider.

Supported plugins are `identity`, `members`, `organizations`, `local-auth`,
`machine-credentials`, `mail-outbox`, `audit`, and `console`. Options follow the
strict built-in schemas; omitting options resets a selected plugin to its
defaults. Permissions-provider options always derive from the current config.
Plugin removal, custom plugins/commands, V3 access editing and GitHub
`submit_change` for composition proposals require separately reviewed changes.
Legacy `propose_change` remains a separate configuration workflow.
