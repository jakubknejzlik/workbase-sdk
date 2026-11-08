# Contributing

Fork the repository, create a branch, and open a pull request. Fork PRs run the
same checks as pushes to main with read-only repository permissions and no
secrets or OIDC access. Maintainers review changes before merging.

Use the Bun version in package.json and Node 25.8.0. Install gitleaks 8.24.3
from its verified release, then run the public CI commands:

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run check:ci-invariants
bun run test
bun run test:mcp
bash scripts/sdk-pack.sh
bun scripts/check-sdk-boundary.ts
bun scripts/scan-sdk-public.ts
```

The packer produces exactly three archives in dist-sdk. Keep source changes
and test fixtures domain-neutral. Preserve licenses and attribution, document
breaking changes in CHANGELOG.md, and report vulnerabilities privately.
