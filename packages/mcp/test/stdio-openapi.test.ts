import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js'
import { loadConfig } from '@workbasehq/core/schema/load'
import { KernelRegistry } from '@workbasehq/core/kernel/registry'
import { generate } from '@workbasehq/core/openapi/generate'
import { csCatalogChanges } from './presentation-fixture.ts'

const hash = (data: string) => createHash('sha256').update(data).digest('hex')

it.each([true, false])('keeps access and locale lifecycles strictly JSON-RPC over stdio (OpenAPI present: %s)', async openapi => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'mcp-stdio-openapi-')))
  const root = join(parent, 'instance'), wire = join(parent, 'stdout.jsonl')
  // Tee the actual server bytes, unchanged, into both the SDK parser and a raw
  // transcript. The SDK must report zero errors; every captured line is checked.
  await mkdir(root)
  const recorder = join(parent, 'record.mjs')
  await writeFile(recorder, `
    import { spawn } from 'node:child_process'
    import { appendFileSync } from 'node:fs'
    const child = spawn(process.execPath, process.argv.slice(2), { stdio: ['pipe', 'pipe', 'inherit'] })
    process.stdin.pipe(child.stdin)
    child.stdout.on('data', data => { appendFileSync(${JSON.stringify(wire)}, data); process.stdout.write(data) })
    child.on('exit', code => { process.exitCode = code ?? 1; process.stdin.destroy() })
    process.on('SIGTERM', () => child.kill('SIGTERM'))
  `)
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [recorder, '--import', resolve('packages/mcp/node_modules/tsx/dist/loader.mjs'), resolve('packages/mcp/src/stdio.ts'), '--root', root],
    stderr: 'pipe', env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  })
  let stderr = ''
  transport.stderr?.on('data', data => { stderr += data })
  const errors: Error[] = []
  const client = new Client({ name: 'strict-openapi-regression', version: '1' })
  client.onerror = error => { errors.push(error) }
  const call = async (name: string, args: Record<string, unknown>, ok = true) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 })
    expect(result.isError, JSON.stringify(result)).toBe(!ok)
    expect(result.structuredContent, JSON.stringify(result)).toMatchObject({ ok })
    return result.structuredContent as any
  }
  try {
    await client.connect(transport)
    await call('bootstrap_instance', { id: 'stdio_fixture', target: 'cloudflare-github' })
    await symlink(resolve('node_modules'), join(root, 'node_modules'))
    const initial = await call('initialize_instance', { instance: 'stdio-fixture', mode: 'preview' })
    const rejected = await call('initialize_instance', { instance: 'stdio-fixture', mode: 'apply', planHash: '0'.repeat(64) }, false)
    expect(rejected.error.code).toBe('stale_plan')
    await call('initialize_instance', { instance: 'stdio-fixture', mode: 'apply', planHash: initial.planHash })
    for (const file of initial.files) expect(hash(await readFile(join(root, file.path), 'utf8'))).toBe(file.hash)
    if (!openapi) {
      const config = join(root, 'config.ts')
      await writeFile(config, (await readFile(config, 'utf8'))
        .replace(', bindOpenApi', '').replace("import spec from './openapi.json'\n", '')
        .replace('bindOpenApi(bindSchemaLock(', 'bindSchemaLock(').replace('}), lock), spec)', '}), lock)'))
      await rm(join(root, 'openapi.json'))
    }
    const domain = ['schema.lock.json', 'migrations/0001_r1.sql']
    const before = await Promise.all(domain.map(path => readFile(join(root, path), 'utf8')))
    const invalid = await call('propose_composition', { instance: 'stdio-fixture', baseRevision: 1,
      changes: [{ kind: 'set_entity_access', entity: 'worker', role: 'ghost', access: 'deny' }] }, false)
    expect(invalid.error.code).toBe('invalid_access')
    for (const [tool, changes] of [
      ['propose_composition', [{ kind: 'set_entity_access', entity: 'worker', role: 'staff', access: { read: 'allow', create: 'deny', update: 'deny', delete: 'deny' } }]],
      ['propose_change', [{ kind: 'set_locale', languages: ['en', 'cs'], locale: 'cs' }, ...csCatalogChanges]],
    ] as const) {
      const oldSpec = await readFile(join(root, 'openapi.json'), 'utf8').catch(() => undefined)
      const proposal = await call(tool, { instance: 'stdio-fixture', baseRevision: 1, changes })
      const args = { proposalId: proposal.proposalId }
      await call('validate', args)
      const preview = await call('preview_migration', args)
      const spec = preview.files.find((file: any) => file.path === 'openapi.json')?.data
      if (openapi) expect(spec).not.toBe(oldSpec)
      else expect(spec).toBeUndefined()
      expect(await call('apply_to_disposable', args)).toMatchObject({ verified: true, diffs: [] })
      expect(await call('promote', { ...args, expectedRevision: 1 })).toMatchObject({ status: 'promoted', revision: 1 })
      for (const file of preview.files) expect(await readFile(join(root, file.path), 'utf8')).toBe(file.data)
      const loaded = await loadConfig(join(root, 'config.ts'))
      if (openapi) {
        const kernel = new KernelRegistry(loaded.config)
        const expected = generate(kernel.config, kernel, loaded.configHash)
        const promoted = await readFile(join(root, 'openapi.json'), 'utf8')
        expect(promoted).toBe(expected)
        expect(hash(promoted)).toBe(hash(spec))
        expect(JSON.parse(promoted)['x-workbase-config-hash']).toBe(loaded.configHash)
      } else await expect(readFile(join(root, 'openapi.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(await Promise.all(domain.map(path => readFile(join(root, path), 'utf8')))).toEqual(before)
    await client.close(); await transport.close()
    const stdout = await readFile(wire, 'utf8')
    expect(stdout.endsWith('\n')).toBe(true)
    const lines = stdout.slice(0, -1).split('\n')
    for (const line of lines) expect(JSONRPCMessageSchema.safeParse(JSON.parse(line)).success, line).toBe(true)
    expect(lines).toHaveLength(16)
    expect(errors).toEqual([])
    expect(stderr.match(/openapi:write: regenerated openapi.json/g) ?? []).toHaveLength(openapi ? 10 : 0)
  } catch (error) {
    throw new Error(`Stdio lifecycle failed; stderr: ${stderr}`, { cause: error })
  } finally {
    await client.close(); await transport.close()
    await rm(parent, { recursive: true, force: true })
  }
})
