# Instance {{INSTANCE_ID}}

Selector: `{{INSTANCE_SELECTOR}}`.
Read README.md for installation, artifact generation and the review workflow.

This is the phase-2 handwritten V3 reference path. Keep declarative schema in
`schema/*`, literal config in `config.ts`, executable composition in `runtime.ts`,
access rules in `access.ts`, pages in `ui/*` and translations in `locales/*`.
Generate schema lock and migration, then access locks, then OpenAPI; run
`bun run check` and `bun run typecheck` before review. Never hand-edit generated
artifacts.
The console uses the installed SDK's prebuilt assets from `@workbasehq/plugins`;
pass `assetsDir: consoleAssetsDir()` from `@workbasehq/plugins/console/assets` to
SDK `provision()`. No Instance console build is needed. Do not add seeded accounts.

Managers operating this Instance later must use the approved MCP/PR workflow and
must not edit code directly. The bundled config-writer is a legacy interface;
the template registers separate data and ops MCP servers with environment-only
credentials. For dev/test onboarding, follow README.md and `docs/sdk/onboarding.md`
in the SDK repository: request sign-in, use `read_dev_mail`, complete the profile,
then `provision_organization` and invite staff. Keep registration open and
`allowCreate: false`; never seed identities or enable self-service creation to
bypass operator provisioning. `EMAIL_FROM` and `WORKBASE_DEV_MAILBOX_TOKEN` are
mutually exclusive; the mailbox is limited to exact dev/test stages.
See README.md for installation,
artifact generation and repeated-init conflict behavior.
