import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { bootstrapInstance } from '../src/bootstrap'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function empty() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mcp-bootstrap-')))
  roots.push(root)
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
  expect(await readFile(join(root, 'CLAUDE.md'), 'utf8')).toContain('SDK getting-started guide')
  expect((await readFile(join(root, 'README.md'), 'utf8')).replace(/\s+/g, ' ')).toContain('SDK getting-started guide')
  expect(await readFile(join(root, 'README.md'), 'utf8')).toContain('branch/MCP/PR guide')
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const { version } = JSON.parse(await readFile(resolve('packages/mcp/package.json'), 'utf8'))
  expect(Object.values(pkg.dependencies)).toEqual([version, version, version])
  expect(pkg.overrides).toBeUndefined()
  const config = await readFile(join(root, 'config.ts'), 'utf8')
  expect(config).toContain('entities: {}')
  expect(config).toContain('permissions: {}')
  expect(config).toContain('policies: {}')
  expect(config).not.toContain('assets:')
  const sst = await readFile(join(root, 'sst.config.ts'), 'utf8')
  expect(sst).toContain('@workbasehq/core/infra/provision')
  expect(sst).toContain('assetsDir: consoleAssetsDir()')
  for (const path of files) expect(await readFile(join(root, path), 'utf8')).not.toMatch(/workspace:|file:|overrides|tarball|public-console|BOOTSTRAP GAP/i)
  expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).name).toBe('workbase-demo-sandbox')
  const wrangler = JSON.parse(await readFile(join(root, 'wrangler.jsonc'), 'utf8'))
  expect(wrangler.name).toBe('workbase-demo-sandbox')
  expect(wrangler.d1_databases[0]).toMatchObject({ database_name: wrangler.name, database_id: '00000000-0000-0000-0000-000000000091' })
  expect(wrangler.queues.producers[0].queue).toBe('workbase-demo-sandbox-events')
  expect(wrangler.queues.consumers[0].dead_letter_queue).toBe('workbase-demo-sandbox-events-dlq')
  expect((await bootstrapInstance(root, input)).files).toEqual(files.map(path => ({ path, status: 'unchanged' })))
  expect((await readFile(join(root, 'proposals/log.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).tool)).toEqual(['bootstrap_instance', 'bootstrap_instance'])
})
it('bootstrap_instance output documents set_label and set_locale with examples', async () => {
  const root = await empty()
  expect((await bootstrapInstance(root, input)).ok).toBe(true)
  const guide = await readFile(join(root, 'CLAUDE.md'), 'utf8')
  expect(guide).toContain('set_label')
  expect(guide).toContain('set_locale')
  expect(guide).toContain('"kind": "set_label"')
  expect(guide).toContain('"kind": "set_locale"')
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
  expect(Object.values(manifest.dependencies)).toEqual(['0.2.0-test', '0.2.0-test', '0.2.0-test'])
})
