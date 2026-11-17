import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { URL } from 'node:url'
import ts from 'typescript'
import { expect, it } from 'vitest'
import { ProvisionDiagnostic, validateProvisionOptions } from '../../core/src/infra/provision'

// Run the shipped template with the real core validation boundary. Only local
// build/resource registration are replaced; no provider or cloud calls occur.
function template(extra: Record<string, string | undefined>, stage = 'prefix-pr-123') {
  const resources: unknown[] = [], builds: unknown[] = []
  const env = { WORKBASE_RESOURCE_PREFIX: 'neutral', BETTER_AUTH_SECRET: 'test-only-'.repeat(4),
    WORKBASE_OPS_TOKEN: 'example-ops', EMAIL_FROM: 'login@example.test', ...extra }
  const source = readFileSync(new URL('../templates/standalone/sst.config.ts', import.meta.url), 'utf8')
    .replace("await import('@workbasehq/core/infra/provision')", 'infra')
    .replace("await import('node:child_process')", 'childProcess')
    .replace('export default', 'globalThis.config =')
  const context = { process: { env }, $app: { stage }, $config: (value: unknown) => value,
    infra: { ProvisionDiagnostic, provision: async (options: Parameters<typeof validateProvisionOptions>[0]) => {
      const origin = validateProvisionOptions(options)
      resources.push({ options, origin })
      return { url: origin.publicOrigin, databaseId: 'test-db' }
    } }, childProcess: { execFileSync: (...args: unknown[]) => builds.push(args) },
    config: undefined as unknown as { run(): Promise<unknown> },
  }
  runInNewContext(ts.transpile(source, { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext }), context)
  return { run: () => context.config.run(), resources, builds }
}

it.each([
  { env: { WORKBASE_PUBLIC_HOSTNAME: ' APP.Example.Test ', AUTH_BASE_URL: '  ' }, origin: 'https://app.example.test', hostname: 'app.example.test' },
  { env: { WORKBASE_PUBLIC_HOSTNAME: '  ', AUTH_BASE_URL: ' https://worker-{stage}.example.test ' }, origin: 'https://worker-prefix-pr-123.example.test', hostname: undefined },
])('treats blank env as unset and resolves the generated config (#%#)', async ({ env, origin, hostname }) => {
  const config = template(env)
  await expect(config.run()).resolves.toMatchObject({ url: origin })
  expect(config.resources).toMatchObject([{ origin: { publicOrigin: origin, ...(hostname ? { publicHostname: hostname } : {}), warnings: [] } }])
  if (!hostname) expect(config.resources[0]).toMatchObject({ options: { publicHostname: undefined } })
  expect(config.builds).toHaveLength(1)
})

it.each([
  { env: {}, code: 'provision_missing_public_origin' },
  { env: { WORKBASE_PUBLIC_HOSTNAME: ' ', AUTH_BASE_URL: '\t' }, code: 'provision_missing_public_origin' },
  { env: { WORKBASE_PUBLIC_HOSTNAME: 'app-{stage}.example.test', AUTH_BASE_URL: 'https://fallback.example.test' }, code: 'provision_invalid_public_hostname' },
  { env: { WORKBASE_DOMAIN: 'old.example.test' }, code: 'provision_legacy_domain_env' },
  { env: { WORKBASE_DOMAIN: '', WORKBASE_PUBLIC_HOSTNAME: 'app.example.test' }, code: 'provision_legacy_domain_env' },
])('fails generated config with typed $code before resources (#%#)', async ({ env, code }) => {
  const config = template(env)
  await expect(config.run()).rejects.toMatchObject({ name: 'ProvisionDiagnostic', code })
  expect(config.resources).toEqual([])
  if (code === 'provision_legacy_domain_env') {
    await expect(config.run()).rejects.toThrow('WORKBASE_PUBLIC_HOSTNAME')
    expect(config.builds).toEqual([])
  }
})
