# Instance {{INSTANCE_ID}}

Selector: `{{INSTANCE_SELECTOR}}`.
Read README.md for installation, artifact generation and the review workflow.

This is the phase-2 handwritten V3 reference path. Keep declarative schema in
`schema/*`, literal config in `config.ts`, executable composition in `runtime.ts`,
access rules in `access.ts`, pages in `ui/*` and translations in `locales/*`.
Generate schema lock and migration, then OpenAPI, then access locks; run
`bun run check` and `bun run typecheck` before review. Never hand-edit generated
artifacts.
Run `bun run build:console` to validate and bundle the Instance UI into
`dist/console`. Both Wrangler and SST rebuild and serve that directory using
public SDK renderer/auth/style exports, following ADR 0008 (superseding SDK #45). Do not add seeded accounts.

Deployment takes `WORKBASE_PUBLIC_HOSTNAME` as a literal bare hostname and derives
the HTTPS auth origin plus a Cloudflare Custom Domain (DNS/certificate managed).
A set value must be a valid lowercase ASCII hostname using only `[a-z0-9.-]`,
validated without normalization. Only an unset `WORKBASE_PUBLIC_HOSTNAME` means
no public hostname; an empty or whitespace-only set value fails fast, even with
a valid `AUTH_BASE_URL`.
Use `AUTH_BASE_URL` only as the HTTPS fallback without a hostname; only that value
expands `{stage}` for previews. Blank `AUTH_BASE_URL` values are unset; at least
one input is required.
A hostname wins over a stale fallback with a warning; an invalid hostname fails.
Existing scaffolds must replace the removed hostname env variable and `domain`
option with `WORKBASE_PUBLIC_HOSTNAME` and `publicHostname`; legacy inputs fail.
Separately launched MCP clients must set `WORKBASE_BASE_URL` to that resolved
origin themselves: deployment env is not inherited.

Managers operating this Instance later must use the approved MCP/PR workflow and
must not edit code directly. The template registers `workbase_config` for local V3 authoring,
plus separate data and ops MCP servers with environment-only credentials. For dev/test onboarding, follow README.md and `docs/sdk/onboarding.md`
in the SDK repository: request sign-in, use `read_dev_mail`, complete the profile,
then `provision_organization` and invite staff. Keep registration open and
`allowCreate: false`; never seed identities or enable self-service creation to
bypass operator provisioning. `EMAIL_FROM` and `WORKBASE_DEV_MAILBOX_TOKEN` are
mutually exclusive; the mailbox is limited to exact dev/test stages.
See README.md for installation,
artifact generation and repeated-init conflict behavior.

For V3 authoring, start `workbase_config` from this Instance directory after
installing the SDK dependencies. It runs `workbase config --root .`
and needs no API credentials or optional environment variables. For a fresh
scaffold, call `initialize_instance` with `instance: "{{INSTANCE_SELECTOR}}"` and
`mode: "preview"`, then `mode: "apply"` with the returned `planHash`. Preview
writes nothing; apply publishes the initial artifacts locally. Then use
`inspect_schema` with selector `{{INSTANCE_SELECTOR}}`, then `propose_composition`
with that `instance`, the inspected `baseRevision`, and `changes`. Supported kinds:
`set_plugin` adds a built-in plugin or replaces its options; `set_interactive`
sets interactive login; `set_system_access` replaces a role's system grants;
`set_entity_access` replaces a role's entity access; `set_account_link` sets an
entity's invitation role. Enable the console with `set_plugin` and plugin `console`.

Continue with `validate` → `preview_migration` → `apply_to_disposable` → `promote`.
Pass the returned `proposalId` to each tool and the inspected revision as
`expectedRevision` to `promote`. Review validation requirements and previewed
files/plugin SQL before disposable verification. Promotion writes local reviewable
sources and access locks; access changes also regenerate an existing OpenAPI
artifact. It preserves the domain revision and does not deploy or apply to a live
database. Review and commit the files through the approved PR process, then deploy
through SDK migration orchestration. Revalidate and verify again after input changes.
V3 domain-change promotion is unsupported and returns `v3_promote_unsupported`;
physical schema changes require reviewed source edits and migration generation.
Custom plugins/commands, plugin removal and role definitions also require reviewed
source changes. Do not mix legacy changes with these V3 kinds in one proposal.

Fresh V3 MCP workflow: `bootstrap_instance` → `initialize_instance` (preview, then
apply with the returned `planHash`) → `inspect_schema`. Dependencies must already
be provisioned. Initialization writes schema, migration, OpenAPI and composed
access artifacts locally; it never installs or deploys. Existing differing or
partial artifacts require review and are never overwritten.
