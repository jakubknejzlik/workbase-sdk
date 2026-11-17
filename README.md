# Workbase SDK

Workbase is a TypeScript SDK for configuration-defined business applications.
It includes schema and migration tooling, reusable plugins, a generic console,
and configuration and data MCP servers.

New V3 standalone Instances author schema, access, pages and translations as code.
An Instance Vite console host builds its routes, browser components and dictionaries
with the SDK renderer/auth/CSS into `dist/console`. Wrangler and SST rebuild and
serve that directory. HTML and `build-meta.json` share a SHA covering the emitted
assets, including copied `public/` files; provisioning verifies that identity.
Keep all three SDK packages on
the same exact version; until the coordinated version is published, use the three
tarball dependencies and identical overrides documented in the getting-started
guide. Start with the
[getting started guide](docs/sdk/getting-started.md), the
[console UI guide](packages/plugins/console/ui/README.md), and the
[release guide](docs/sdk/release.md).
See [row policies](docs/sdk/policies.md) for actor-based access rules.
See [MCP composition](docs/sdk/mcp-composition.md) for built-in V3 runtime authoring.

See [CONTRIBUTING.md](CONTRIBUTING.md) for local checks and
[SECURITY.md](SECURITY.md) for private vulnerability reporting.
The SDK is licensed under [Apache-2.0](LICENSE).
