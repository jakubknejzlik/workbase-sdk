import { registerTempDir, cleanupTempDir } from '../../../scripts/lib/test-temp-dir.mjs'
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { bootstrapInstance } from '../src/bootstrap'
import { compositionChangeSchema, schemas } from '../src/schemas'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) cleanupTempDir(root) })
async function empty() {
  const directory = registerTempDir(await mkdtemp(join(tmpdir(), 'mcp-bootstrap-')))
  roots.push(directory)
  const root = await realpath(directory)
  return root
}
const input = { id: 'demo_sandbox', target: 'cloudflare-github' as const }
async function tree(root: string) {
  const paths = (await readdir(root, { recursive: true, withFileTypes: true })).map(entry => ({
    path: join(entry.parentPath, entry.name).slice(root.length + 1), directory: entry.isDirectory(),
  })).sort((a, b) => a.path.localeCompare(b.path))
  return Promise.all(paths.map(async entry => ({ ...entry,
    bytes: entry.directory ? null : (await readFile(join(root, entry.path))).toString('base64'),
  })))
}
it('creates registry-only files, substitutes ids and resolves the release version', async () => {
  const root = await empty()
  const result = await bootstrapInstance(root, input)
  const template = resolve('packages/mcp/templates/standalone')
  const files = (await readdir(template, { recursive: true, withFileTypes: true })).filter(f => f.isFile()).map(f => join(f.parentPath, f.name).slice(template.length + 1)).map(path => path === 'gitignore' ? '.gitignore' : path).sort()
  expect(result.ok).toBe(true)
  expect(result.files).toEqual(files.map(path => ({ path, status: 'created' })))
  expect(await readFile(join(root, 'config.ts'), 'utf8')).toContain("id: 'demo_sandbox'")
  expect(await readFile(join(root, 'CLAUDE.md'), 'utf8')).toContain('`demo-sandbox`')
  expect(await readFile(join(root, 'CLAUDE.md'), 'utf8')).toContain('Read README.md for installation, artifact generation and the review workflow.')
  expect(await readFile(join(root, 'README.md'), 'utf8')).toContain('docs/sdk/getting-started.md')
  expect(await readFile(join(root, 'README.md'), 'utf8')).toContain('For later Manager operation use the established MCP/PR process')
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const { version } = JSON.parse(await readFile(resolve('packages/mcp/package.json'), 'utf8'))
  for (const name of ['core', 'mcp', 'plugins']) expect(pkg.dependencies[`@workbasehq/${name}`]).toBe(version)
  expect(pkg.dependencies.react).toBe('19.2.8')
  expect(pkg.devDependencies.sst).toBe('4.17.1')
  expect(pkg.scripts['typecheck']).toContain('generate:ui &&')
  expect(pkg.scripts['build:console']).toBe('bun run check:ui && bun --bun vite build')
  expect(pkg.scripts.dev).toBe('bun run dev:worker')
  expect(pkg.scripts.check).toBe('bun run check:schema && bun run check:access && bun run check:openapi && bun run check:ui')
  expect(pkg.scripts.deploy).toBe('bun run check && sst deploy')
  expect(pkg.overrides).toBeUndefined()
  const config = await readFile(join(root, 'config.ts'), 'utf8')
  expect(config).toContain('bindSchemaLock(defineConfig({')
  expect(config).toContain('entities: { worker }, access')
  expect(config).toContain("import spec from './openapi.json'")
  expect(config).toContain('bindOpenApi(bindSchemaLock(defineConfig({')
  expect(config).toContain('}), lock), spec)')
  expect(config).not.toContain('assets:')
  const sst = await readFile(join(root, 'sst.config.ts'), 'utf8')
  expect(sst).toContain('@workbasehq/core/infra/provision')
  expect(sst).toContain("assetsDir: './dist/console'")
  expect(sst).toContain("configPath: './runtime.ts'")
  expect(sst).toContain("execFileSync('bun', ['run', 'build:console']")
  for (const path of files) expect(await readFile(join(root, path), 'utf8')).not.toMatch(/workspace:|link:|\{\{(?:SDK_VERSION|INSTANCE_ID|INSTANCE_SELECTOR|INSTANCE_DISPLAY_NAME)\}\}/)
  expect(JSON.parse(await readFile(join(root, 'tsconfig.json'), 'utf8')).compilerOptions.paths).toBeUndefined()
  expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).name).toBe('workbase-demo-sandbox')
  const wrangler = JSON.parse(await readFile(join(root, 'wrangler.jsonc'), 'utf8'))
  expect(wrangler.name).toBe('workbase-demo-sandbox')
  expect(wrangler.d1_databases[0]).toMatchObject({ database_name: wrangler.name, database_id: '0'.repeat(32) })
  expect(wrangler.kv_namespaces[0].id).toBe('0'.repeat(32))
  expect(wrangler.assets).toEqual({ directory: './dist/console',
    binding: 'ASSETS', html_handling: 'none', not_found_handling: 'none', run_worker_first: true })
  expect(wrangler.build.command).toBe('bun run build:console')
  expect(wrangler.queues.producers[0].queue).toBe('workbase-demo-sandbox-events')
  expect(wrangler.queues.consumers[0].dead_letter_queue).toBe('workbase-demo-sandbox-events-dlq')
  expect((await bootstrapInstance(root, input)).files).toEqual(files.map(path => ({ path, status: 'unchanged' })))
  expect((await readFile(join(root, 'proposals/log.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).tool)).toEqual(['bootstrap_instance', 'bootstrap_instance'])
})
it.each([
  { stage: 'trial', email: 'login@example.test', mailbox: '', error: undefined },
  { stage: 'dev', email: '', mailbox: 'synthetic-mailbox-secret-at-least-32', error: undefined },
  { stage: 'test', email: '', mailbox: 'synthetic-mailbox-secret-at-least-32', error: undefined },
  { stage: 'dev', email: 'login@example.test', mailbox: 'synthetic-mailbox-secret-at-least-32', error: 'EMAIL_FROM cannot be combined with WORKBASE_DEV_MAILBOX_TOKEN' },
  { stage: 'production', email: '', mailbox: 'synthetic-mailbox-secret-at-least-32', error: 'WORKBASE_DEV_MAILBOX_TOKEN requires dev or test stage' },
  { stage: 'dev', email: '', mailbox: '', error: 'Set EMAIL_FROM before running SST' },
])('runs the generated SST config with deployment inputs %j', async ({ stage, email, mailbox, error }) => {
  const root = await empty()
  await bootstrapInstance(root, input)
  await symlink(resolve('node_modules'), join(root, 'node_modules'))
  await mkdir(join(root, '.test-bin'))
  await writeFile(join(root, '.test-bin/bun'), '#!/bin/sh\nprintf "%s\\n" "$*" > build-command.txt\n')
  await chmod(join(root, '.test-bin/bun'), 0o755)
  const script = `import { mock } from 'bun:test'
const { resolvePublicOrigin } = await import(${JSON.stringify(resolve('packages/core/src/infra/public-origin.ts'))})
process.env.PATH = ${JSON.stringify(join(root, '.test-bin'))} + ':' + process.env.PATH
let options
mock.module('@workbasehq/core/infra/provision', () => ({ resolvePublicOrigin, provision: async value => {
  options = value
  return { url: 'https://example.test', databaseId: 'test-db', ...(value.devMailbox ? { devMailboxUrl: 'https://mailbox.example.test' } : {}) }
} }))
globalThis.$config = value => value
globalThis.$app = { stage: ${JSON.stringify(stage)} }
const { default: config } = await import('./sst.config.ts')
try {
  const result = await config.run()
  console.log(JSON.stringify({ options, expected: './dist/console', result }))
} catch (error) { console.log(JSON.stringify({ error: error.message, called: Boolean(options) })) }`
  const inherited = { ...process.env }
  delete inherited.WORKBASE_DOMAIN
  delete inherited.WORKBASE_PUBLIC_HOSTNAME
  const result = spawnSync('bun', ['--no-install', '--eval', script], { cwd: root, encoding: 'utf8', env: {
    ...inherited, WORKBASE_RESOURCE_PREFIX: 'test-instance', BETTER_AUTH_SECRET: 'test-secret',
    AUTH_BASE_URL: 'https://{stage}.example.test', EMAIL_FROM: email,
    WORKBASE_OPS_TOKEN: 'example-ops', WORKBASE_DEV_MAILBOX_TOKEN: mailbox,
  } })
  expect(result.status, result.stderr).toBe(0)
  if (error) {
    expect(JSON.parse(result.stdout)).toEqual({ error, called: false })
    return
  }
  const { options, expected, result: deployed } = JSON.parse(result.stdout)
  expect((await readFile(join(root, 'build-command.txt'), 'utf8')).trim()).toBe('run build:console')
  expect(options.assetsDir).toBe(expected)
  expect(options.configPath).toBe('./runtime.ts')
  expect(options.authBaseUrl).toBe(`https://${stage}.example.test`)
  expect(options.opsToken).toBe('example-ops')
  expect(options.email).toEqual(email ? { from: email } : undefined)
  expect(options.devMailbox).toEqual(mailbox ? { token: mailbox } : undefined)
  expect(deployed).toEqual({ url: 'https://example.test', databaseId: 'test-db',
    ...(mailbox ? { devMailboxUrl: 'https://mailbox.example.test' } : {}) })
})
it('ships authored V3 sources and excludes Instance-generated artifacts', async () => {
  const root = await empty()
  const { files } = await bootstrapInstance(root, input)
  const paths = files.map(file => file.path)
  for (const path of ['runtime.ts', 'access.ts', 'schema/worker.ts', 'ui/nav.ts', 'ui/-slots.ts',
    'ui/workers/index.ts', 'ui/workers/new.ts', 'ui/workers/$workerId/index.ts', 'ui/workers/$workerId/edit.ts',
    'locales/en/domain.json', 'locales/en/ui.json', 'src/console.tsx', 'vite.config.ts', 'index.html', 'src/worker.ts', 'scripts/check-ui.ts', 'scripts/generate-ui.ts', 'migrations/.gitkeep']) expect(paths).toContain(path)
  for (const path of ['schema.lock.json', 'migrations/0001_r1.sql', 'access.lock.json', 'access.lock.md', 'openapi.json',
    'scripts/initial-migrations.ts', 'scripts/check-migrations.ts', 'scripts/ci-config.ts', 'scripts/deploy.ts']) expect(paths).not.toContain(path)
  const servers = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8')).mcpServers
  expect(Object.keys(servers)).toEqual(['workbase_data', 'workbase_ops', 'workbase_config'])
  expect(servers.workbase_config).toEqual({ command: 'bun',
    args: ['./node_modules/@workbasehq/mcp/src/bin.ts', 'config', '--root', '.'] })
  expect(servers.workbase_ops.args).toEqual(['./node_modules/@workbasehq/mcp/src/bin.ts', 'ops'])
  expect(servers.workbase_ops.env).toEqual({
    WORKBASE_BASE_URL: '${WORKBASE_BASE_URL}', WORKBASE_OPS_TOKEN: '${WORKBASE_OPS_TOKEN}',
    WORKBASE_DEV_MAILBOX_URL: '${WORKBASE_DEV_MAILBOX_URL:-}', WORKBASE_DEV_MAILBOX_TOKEN: '${WORKBASE_DEV_MAILBOX_TOKEN:-}',
  })
  expect(await readFile(join(root, 'runtime.ts'), 'utf8')).toContain('createOrganizations({ allowCreate: false })')
  expect(await readFile(join(root, 'config.ts'), 'utf8')).toContain("registration: 'open'")
  const guide = await readFile(join(root, 'README.md'), 'utf8')
  expect(guide.indexOf('bun run migrate:plan --init')).toBeLessThan(guide.indexOf('bun run openapi:write'))
  expect(guide.indexOf('bun run openapi:write')).toBeLessThan(guide.indexOf('bun run access:lock'))
  expect(guide).toContain('file:vendor/sdk/workbasehq-core-')
  expect(guide).toContain('"overrides"')
})
it('ignores the generated UI symlink and its sibling generation directory', async () => {
  const root = await empty()
  await bootstrapInstance(root, input)
  const generation = '.workbase-ui.generation-test'
  await mkdir(join(root, generation))
  await writeFile(join(root, generation, 'manifest.json'), '{}\n')
  await symlink(generation, join(root, '.workbase-ui'))
  const git = (...args: string[]) => spawnSync('git', ['-c', 'core.excludesFile=/dev/null', ...args], { cwd: root, encoding: 'utf8' })
  expect(git('init', '-q').status).toBe(0)
  const ignored = git('check-ignore', '.workbase-ui', `${generation}/manifest.json`)
  expect(ignored.status).toBe(0)
  expect(ignored.stdout.trim().split('\n')).toEqual(['.workbase-ui', `${generation}/manifest.json`])
  const status = git('status', '--short', '--', '.workbase-ui*')
  expect(status.status).toBe(0)
  expect(status.stdout).toBe('')
  expect(git('check-ignore', 'ui/workers/index.ts').status).toBe(1)
})
it('preserves authored schema, dependency rewrites and generated artifact bytes on re-init', async () => {
  const root = await empty()
  const first = await bootstrapInstance(root, input)
  const authored = {
    'package.json': '{"private":true,"dependencies":{"@workbasehq/core":"file:vendor/sdk/core.tgz"}}\n',
    'schema/worker.ts': '// authored schema\n',
    'schema.lock.json': '{"generated":"instance"}\n',
    'migrations/0001_r1.sql': '-- instance migration\n',
    'access.lock.json': '{"generated":"access"}\n',
    'access.lock.md': '# Instance access\n',
    'openapi.json': '{"openapi":"3.1.0"}\n',
  }
  for (const [path, bytes] of Object.entries(authored)) await writeFile(join(root, path), bytes)
  const second = await bootstrapInstance(root, input)
  expect(second.files).toEqual(first.files.map(file => ({ path: file.path,
    status: ['package.json', 'schema/worker.ts'].includes(file.path) ? 'conflict' : 'unchanged' })))
  for (const [path, bytes] of Object.entries(authored)) expect(await readFile(join(root, path), 'utf8')).toBe(bytes)
})
it('allows a descendant root and audits only validated calls without caller input', async () => {
  const root = await empty()
  const result = await bootstrapInstance(root, { ...input, root: 'nested/instance' })
  expect(result.files.every(file => file.status === 'created')).toBe(true)
  expect(await readFile(join(root, 'nested/instance/config.ts'), 'utf8')).toContain("id: 'demo_sandbox'")
  await expect(bootstrapInstance(root, { ...input, id: 'private-invalid-value' })).rejects.toMatchObject({ code: 'invalid_instance_id' })
  await expect(bootstrapInstance(root, null)).rejects.toBeDefined()
  const content = await readFile(join(root, 'proposals/log.jsonl'), 'utf8')
  expect(content).not.toContain('private-invalid-value')
  const entries = content.trim().split('\n').map(line => JSON.parse(line))
  expect(entries).toHaveLength(1)
  expect(Object.keys(entries[0]).sort()).toEqual(['callId', 'timestamp', 'tool'])
  expect(entries.every(row => row.tool === 'bootstrap_instance')).toBe(true)
})
it('preserves conflicts and continues creating other missing files', async () => {
  const root = await empty()
  await writeFile(join(root, 'config.ts'), 'KEEP ME\n')
  const result = await bootstrapInstance(root, input)
  expect(result.ok).toBe(true)
  expect(result.files).toContainEqual({ path: 'config.ts', status: 'conflict' })
  expect(result.files).toContainEqual({ path: 'package.json', status: 'created' })
  expect(await readFile(join(root, 'config.ts'), 'utf8')).toBe('KEEP ME\n')
})
it.each(['Bad', '../x', 'a/b', '../outside', 'has-hyphen', 'constructor', 'a'.repeat(64)])('rejects invalid id %s without changing any bytes or paths', async id => {
  const root = await empty()
  await expect(bootstrapInstance(root, { ...input, id })).rejects.toMatchObject({ code: 'invalid_instance_id' })
  expect(await readdir(root)).toEqual([])
  await mkdir(join(root, 'proposals'))
  await writeFile(join(root, 'proposals/log.jsonl'), 'existing audit\n')
  await writeFile(join(root, 'keep.bin'), Buffer.from([0, 255, 42]))
  const before = await tree(root)
  await expect(bootstrapInstance(root, { ...input, id })).rejects.toMatchObject({ code: 'invalid_instance_id' })
  expect(await tree(root)).toEqual(before)
})
it.each([{ target: 'other' }, { root: '../outside' }])('rejects an invalid target %j before any write', async invalid => {
  const root = await empty()
  await expect(bootstrapInstance(root, { ...input, ...invalid })).rejects.toBeDefined()
  expect(await readdir(root)).toEqual([])
})
it('rejects roots outside the server root', async () => {
  await expect(bootstrapInstance(await empty(), { ...input, root: await empty() })).rejects.toMatchObject({ code: 'unsafe_path', status: 403 })
})
it.each([true, false])('rejects server-root ancestor symlinks before any write (existing=%s)', async existing => {
  const root = await empty()
  await mkdir(join(root, 'real'))
  if (existing) await mkdir(join(root, 'real/existing'))
  await symlink(join(root, 'real'), join(root, 'link'))
  await expect(bootstrapInstance(join(root, 'link/existing'), input)).rejects.toMatchObject({ code: 'unsafe_path', status: 403 })
  expect(await readdir(join(root, 'real'), { recursive: true })).toEqual(existing ? ['existing'] : [])
  if (existing) expect(await readdir(join(root, 'real/existing'))).toEqual([])
})
it.each(['root', 'ancestor', 'file', 'directory', 'audit'])('rejects symlinked %s without writing outside', async kind => {
  const root = await empty(), outside = await empty()
  let target = root
  if (kind === 'root') { target = join(root, 'link'); await symlink(outside, target) }
  if (kind === 'ancestor') { await symlink(outside, join(root, 'link')); target = join(root, 'link/child') }
  if (kind === 'file') await symlink(join(outside, 'config.ts'), join(root, 'config.ts'))
  if (kind === 'directory') await symlink(outside, join(root, 'scripts'))
  if (kind === 'audit') await symlink(outside, join(root, 'proposals'))
  await expect(bootstrapInstance(root, { ...input, root: target })).rejects.toMatchObject({ code: 'unsafe_path' })
  expect(await readdir(outside)).toEqual([])
})
it.each(['bun', 'node'])('CLI init prints one JSON line and typed failures under %s', async runtime => {
  const root = await empty()
  const prefix = runtime === 'bun' ? ['--no-install'] : ['--import', resolve('packages/mcp/node_modules/tsx/dist/loader.mjs')]
  const run = (args: string[]) => spawnSync(runtime, [...prefix, resolve('packages/mcp/src/stdio.ts'), 'init', ...args], { encoding: 'utf8' })
  await symlink(root, join(root, 'linked'))
  const result = run(['--root', join(root, 'new'), '--id', input.id, '--target', input.target])
  expect(result.status).toBe(0)
  expect(result.stdout.trim().split('\n')).toHaveLength(1)
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, files: expect.arrayContaining([{ path: 'config.ts', status: 'created' }]) })
  for (const [args, code] of [
    [['--root', root, '--id', 'INVALID', '--target', input.target], 'invalid_instance_id'],
    [['--root', root, '--id', input.id, '--target', 'other'], 'invalid_arguments'],
    [['--root', root], 'invalid_arguments'],
    [['--root', join(root, 'linked'), '--id', input.id, '--target', input.target], 'unsafe_path'],
  ] as const) {
    const failed = run([...args])
    expect(failed.status).toBe(1)
    expect(failed.stdout).toBe('')
    expect(failed.stderr).toMatch(new RegExp(`^error ${code}: [^\\n]+\\n$`))
  }
})
// Mode bits do not deny uid 0; the Railway runner runs as root.
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
it.skipIf(isRoot).each(['bun', 'node'])('init reports read-only filesystem errors as one typed line under %s', async runtime => {
  const root = await empty()
  const prefix = runtime === 'bun' ? ['--no-install'] : ['--import', resolve('packages/mcp/node_modules/tsx/dist/loader.mjs')]
  const run = (debug = '0') => spawnSync(runtime, [...prefix, resolve('packages/mcp/src/stdio.ts'), 'init', '--root', root, '--id', input.id, '--target', input.target],
    { encoding: 'utf8', env: { ...process.env, WORKBASE_DEBUG: debug } })
  await chmod(root, 0o555)
  try {
    await expect(bootstrapInstance(root, input)).rejects.toMatchObject({ code: 'io_error', status: 500 })
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^error io_error: [^\n]+\n$/)
    expect(result.stderr).toContain('EACCES')
    expect(result.stderr).toContain(root)
    expect(result.stderr).not.toContain('    at ')
    expect(await readdir(root)).toEqual([])
    const debug = run('1')
    expect(debug.status).toBe(1)
    expect(debug.stderr).toContain('    at ')
  } finally { await chmod(root, 0o755) }
})
it.each(['bun', 'node'])('bootstraps an empty root through the real %s stdio contract', async runtime => {
  const root = await empty()
  const transport = new StdioClientTransport({ command: runtime, args: [
    ...(runtime === 'bun' ? ['--no-install'] : ['--import', resolve('packages/mcp/node_modules/tsx/dist/loader.mjs')]),
    resolve('packages/mcp/src/stdio.ts'), '--root', root,
  ], stderr: 'pipe' })
  transport.stderr?.on('data', () => {})
  const client = new Client({ name: 'bootstrap-contract', version: '1' })
  try {
    await client.connect(transport)
    expect((await client.listTools()).tools.map(t => t.name)).toContain('bootstrap_instance')
    const rejected = await client.callTool({ name: 'bootstrap_instance', arguments: { ...input, id: 'Bad' } })
    expect(rejected.structuredContent).toMatchObject({ ok: false, error: { code: 'invalid_instance_id' } })
    const result = await client.callTool({ name: 'bootstrap_instance', arguments: input })
    expect(result.isError).toBe(false)
    expect(result.structuredContent).toMatchObject({ ok: true })
    expect((await readFile(join(root, 'proposals/log.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1)
  } finally { await client.close(); await transport.close() }
})
it.each(['bun', 'node'])('init does not load Worker, core or server modules under %s', async runtime => {
  const root = await empty(), tool = join(root, 'tool')
  await mkdir(join(tool, 'src'), { recursive: true })
  await mkdir(join(tool, 'node_modules'), { recursive: true })
  await writeFile(join(tool, 'package.json'), '{"type":"module","version":"0.2.0-test"}')
  // These are all init's source dependencies. server.ts/storage.ts are deliberately absent.
  for (const file of ['stdio.ts', 'cli.ts', 'schemas.ts', 'bootstrap.ts', 'paths.ts']) await cp(resolve('packages/mcp/src', file), join(tool, 'src', file))
  await cp(resolve('packages/mcp/templates/standalone'), join(tool, 'templates/standalone'), { recursive: true })
  await symlink(resolve('packages/mcp/node_modules/zod'), join(tool, 'node_modules/zod'))
  const result = spawnSync(runtime, [
    ...(runtime === 'bun' ? ['--no-install'] : ['--import', resolve('packages/mcp/node_modules/tsx/dist/loader.mjs')]),
    join(tool, 'src/stdio.ts'), 'init', '--root', join(root, 'instance'), '--id', input.id, '--target', input.target,
  ], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout).ok).toBe(true)
  const manifest = JSON.parse(await readFile(join(root, 'instance/package.json'), 'utf8'))
  for (const name of ['core', 'plugins', 'mcp']) expect(manifest.dependencies[`@workbasehq/${name}`]).toBe('0.2.0-test')
})
it.each([false, true])('starts generated workbase_ops after client interpolation (mailbox configured=%s)', async mailbox => {
  const root = await empty()
  await bootstrapInstance(root, input)
  await mkdir(join(root, 'node_modules/@workbasehq'), { recursive: true })
  await symlink(resolve('packages/mcp'), join(root, 'node_modules/@workbasehq/mcp'))
  const { workbase_ops: config } = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8')).mcpServers as Record<string, {
    command: string; args: string[]; env: Record<string, string>
  }>
  // Model Claude Code's documented .mcp.json interpolation.
  // Unset references remain literal unless a default is present; empty strings count as set.
  const shell: Record<string, string> = {
    WORKBASE_BASE_URL: 'https://example.test', WORKBASE_OPS_TOKEN: 'example-ops',
    ...(mailbox ? { WORKBASE_DEV_MAILBOX_URL: 'https://mailbox.example.test',
      WORKBASE_DEV_MAILBOX_TOKEN: 'synthetic-mailbox-secret-at-least-32' } : {}),
  }
  const expand = (value: string) => value.replace(/\$\{([^}:]+)(?::-([^}]*))?\}/g,
    (literal, key: string, fallback: string | undefined) => shell[key] ?? fallback ?? literal)
  const transport = new StdioClientTransport({
    command: expand(config.command), args: config.args.map(expand), cwd: root, stderr: 'pipe',
    env: { ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
      ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
      ...Object.fromEntries(Object.entries(config.env).map(([key, value]) => [key, expand(value)])) },
  })
  transport.stderr?.on('data', () => {})
  const client = new Client({ name: 'generated-ops-config', version: '1' })
  try {
    await client.connect(transport)
    expect((await client.listTools()).tools.map(tool => tool.name))
      .toEqual(['provision_organization', 'bootstrap_instance_owner', ...(mailbox ? ['read_dev_mail'] : [])])
  } finally { await client.close(); await transport.close() }
})

it('starts generated workbase_config with no optional environment variables', async () => {
  const root = await empty()
  await bootstrapInstance(root, input)
  await mkdir(join(root, 'node_modules/@workbasehq'), { recursive: true })
  for (const name of ['core', 'plugins', 'mcp']) await symlink(resolve('packages', name), join(root, 'node_modules/@workbasehq', name))
  const config = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8')).mcpServers.workbase_config
  const transport = new StdioClientTransport({
    command: config.command, args: config.args, cwd: root, stderr: 'pipe',
    env: { ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
      ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }) },
  })
  transport.stderr?.on('data', () => {})
  const client = new Client({ name: 'generated-config', version: '1' })
  try {
    await client.connect(transport)
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(Object.keys(schemas))
  } finally { await client.close(); await transport.close() }
})

it.each([
  'packages/mcp/templates/standalone/CLAUDE.md',
  'packages/mcp/templates/standalone/README.md',
  'docs/sdk/consumption.md',
  'docs/sdk/getting-started.md',
  'docs/sdk/mcp-composition.md',
])('documents the implemented V3 kinds and workflow in %s', async path => {
  const guide = await readFile(resolve(path), 'utf8')
  const examples = [
    { kind: 'set_plugin', plugin: 'console' },
    { kind: 'set_interactive', interactive: true },
    { kind: 'set_system_access', role: 'admin', grants: { 'members.read': 'allow' } },
    { kind: 'set_entity_access', entity: 'worker', role: 'staff', access: 'deny' },
    { kind: 'set_account_link', entity: 'worker', invitationRole: 'staff' },
    ...(path === 'docs/sdk/mcp-composition.md' ? [
      { kind: 'set_locale', languages: ['en', 'cs'] },
      { kind: 'set_label', entity: 'worker', language: 'en', pluralForms: { one: '{{count}} worker', other: '{{count}} workers' }, singular: 'Worker', object: 'worker' },
      { kind: 'set_catalog_entries', language: 'en', namespace: 'domain', entries: { 'field.worker.name': 'Name' } },
      { kind: 'set_instance_display_name', displayName: 'Field Ops' },
      { kind: 'set_roles', roles: ['owner', 'viewer'], organizationOwnerRole: 'owner' },
      { kind: 'set_constraints', entity: 'worker', constraints: [{ kind: 'unique', name: 'worker_name_unique', fields: ['name'] }] },
      { kind: 'add_index', entity: 'worker', name: 'worker_name_idx', fields: ['name'] },
    ] : []),
  ]
  const kinds = examples.map(change => schemas.propose_change.parse({ instance: 'example', baseRevision: 1, changes: [change] }).changes[0].kind)
  for (const kind of kinds) expect(guide, kind).toContain('`' + kind + '`')
  for (const [kind] of guide.matchAll(/\b(?:set|add|remove)_[a-z_]+\b/g)) {
    expect(kinds).toContain(kind)
  }
  const workflow = ['inspect_schema', 'propose_composition', 'validate', 'preview_migration', 'apply_to_disposable', 'promote']
  for (const tool of workflow) {
    expect(schemas).toHaveProperty(tool)
    expect(guide, tool).toContain('`' + tool + '`')
  }
  expect(guide).toContain('v3_promote_unsupported')
})
