# Contributing

Fork the repository, create a branch, and open a pull request. CI uses read-only
repository permissions. Maintainers review changes before merging.

PRs into `integration/*` use targeted local checks. Whenever a changed file has
an exact-line review in `scripts/sdk-scan-policy.json` (including `bun.lock` and
reviewed `package.json` files), or the policy itself changes, also run:

```sh
bun x --no-install vitest run --config vitest.tools.config.ts scripts/sdk-scan-policy.test.ts scripts/check-console-public.test.ts
```

Use the private vocabulary configuration described below. The tooling config is
required because the default Vitest config includes only runtime tests. Verify
every exact-line review against the changed files; retain each digest and update
only line numbers when the reviewed bytes are unchanged.

Use the Bun version in package.json and Node 25.8.0. Install gitleaks 8.24.3
from its verified release, then run the public CI commands:

The leak guards require the maintainer-supplied private vocabulary. Set
`WORKBASE_PRIVATE_TERMS` to its newline-separated contents, or set
`WORKBASE_PRIVATE_TERMS_FILE` to the path of a file outside the checkout with mode
`600`. Preserve the supplied term #N order and append any additional literal
terms after the required entries. The tracked salted digests validate the
configuration; scanned content uses the original regex expressions and flags.
Missing, incomplete or reordered inputs fail closed without printing terms.

Both workflows pass the repository secret `WORKBASE_PRIVATE_TERMS` to the steps
that run the guards. Fork PRs without access to that secret fail those checks;
there is no fallback that skips them. Keep the vocabulary out of tracked files.

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
