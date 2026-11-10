import { registerTempDir, cleanupTempDir } from '../../../scripts/lib/test-temp-dir.mjs'
import { copyHistoricalInstances } from './fixtures'
import { expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { join, resolve } from 'node:path'
import { cp, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { stateRoot } from '../src/disposable.ts'

async function runBin(cwd: string, args: string[] = [], debug = '0') {
  const child = spawn('bun', ['--no-install', resolve('packages/mcp/src/stdio.ts'), ...args], {
    cwd, env: { ...process.env, WORKBASE_DEBUG: debug }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  const [code, signal] = await once(child, 'close')
  return { code, signal, stdout, stderr }
}

it.each([
  ['relative traversal', ['--root', '../..'], 'invalid_instance_directory', 'Expected one configuration directory for the allowed instance'],
  ['invalid arguments', ['--root'], 'invalid_arguments', 'Supported arguments: --root <dir> and --agent-test'],
] as const)('reports %s as one typed stderr line from the bin', async (_name, args, code, message) => {
  const root = registerTempDir(await mkdtemp(join(tmpdir(), 'mcp-startup-')))
  try {
    const cwd = join(root, 'a/b')
    await mkdir(cwd, { recursive: true })
    // A partial instance still fails; a genuinely empty root now serves bootstrap.
    await mkdir(join(root, 'migrations'))
    const result = await runBin(cwd, [...args])
    expect(result).toEqual({ code: 1, signal: null, stdout: '', stderr: `error ${code}: ${message}\n` })
    expect(result.stderr).not.toContain('    at ')
  } finally { cleanupTempDir(root) }
})

it('keeps startup stack traces when WORKBASE_DEBUG=1', async () => {
  const root = registerTempDir(await mkdtemp(join(tmpdir(), 'mcp-startup-debug-')))
  try {
    await mkdir(join(root, 'migrations'))
    const result = await runBin(root, [], '1')
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('invalid_instance_directory')
    expect(result.stderr).toContain('    at ')
  } finally { cleanupTempDir(root) }
})

it.each(['validation', 'unexpected'])('formats %s config startup failures from the bin', async kind => {
  const root = registerTempDir(await mkdtemp(join(tmpdir(), 'mcp-startup-config-')))
  try {
    await mkdir(join(root, 'migrations'))
    await writeFile(join(root, 'config.ts'), kind === 'validation'
      ? `import { z } from ${JSON.stringify(resolve('packages/mcp/node_modules/zod/index.js'))}\nz.string().parse(null)\nexport default {}\n`
      : "throw new Error('UNEXPECTED_STARTUP_FAILURE')\nexport default {}\n")
    const result = await runBin(root)
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    if (kind === 'validation') {
      expect(result.stderr).toBe('error invalid_config: Configuration does not match the schema\n')
    } else {
      expect(result.stderr).toContain('UNEXPECTED_STARTUP_FAILURE')
      expect(result.stderr).toContain('    at ')
      expect(result.stderr).not.toContain('internal_error')
    }
  } finally { cleanupTempDir(root) }
})

it('serves all config tools over a real stdio subprocess and shuts down', async () => {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', resolve('packages/mcp/node_modules/tsx/dist/loader.mjs'), resolve('packages/mcp/src/stdio.ts')],
    cwd: process.cwd(), stderr: 'pipe' })
  transport.stderr?.on('data', () => { /* Node SQLite experimental warnings belong on stderr, never MCP stdout. */ })
  const client = new Client({ name: 'stdio-smoke', version: '1.0.0' })
  try {
    await client.connect(transport)
    const listed = (await client.listTools()).tools
    expect(listed).toHaveLength(12)
    expect(listed.map(tool => tool.name)).toContain('submit_change')
  } finally { await client.close(); await transport.close() }
})

it('stdin EOF cancels a blocked Wrangler group, releases its lock and exits zero within two seconds', async () => {
  await mkdir(stateRoot, { recursive: true })
  const root = registerTempDir(await mkdtemp(join(stateRoot, 'stdio-eof-')))
  const marker = join(root, 'child.json'), terminated = join(root, 'sigterm')
  const dir = join(root, 'examples/sample')
  let server: ReturnType<typeof spawn> | undefined
  let children: { pid: number; descendant: number } | undefined
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
  const waitFor = async (condition: () => Promise<boolean> | boolean, milliseconds = 2000) => {
    const deadline = Date.now() + milliseconds
    while (!(await condition())) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for EOF cleanup')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  try {
    await symlink(resolve('node_modules'), join(root, 'node_modules'))
    await mkdir(join(root, 'packages/mcp'), { recursive: true })
    await cp(resolve('packages/mcp/src'), join(root, 'packages/mcp/src'), { recursive: true })
    await cp(resolve('packages/mcp/package.json'), join(root, 'packages/mcp/package.json'))
    await symlink(resolve('packages/mcp/node_modules'), join(root, 'packages/mcp/node_modules'))
    await writeFile(join(root, 'package.json'), '{"type":"module"}')
    await copyHistoricalInstances(root)
    const blocked = join(root, 'blocked.mjs')
    await writeFile(blocked, `
      import { spawn } from 'node:child_process'
      import { writeFileSync } from 'node:fs'
      process.on('SIGTERM', () => writeFileSync(${JSON.stringify(terminated)}, 'SIGTERM'))
      const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
      child.once('message', () => {
        child.disconnect()
        writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, descendant: child.pid }))
      })
      setInterval(() => {}, 1000)
    `)
    const hook = join(root, 'hook.mjs')
    await writeFile(hook, `
      import cp from 'node:child_process'
      import { syncBuiltinESMExports } from 'node:module'
      const spawn = cp.spawn
      cp.spawn = (command, args, options) => args?.some(a => String(a).endsWith('wrangler.js'))
        ? spawn(process.execPath, [${JSON.stringify(blocked)}], options) : spawn(command, args, options)
      syncBuiltinESMExports()
    `)
    const stateBefore = (await readdir(stateRoot)).sort()
    server = spawn(process.execPath, ['--import', hook, '--import', resolve('packages/mcp/node_modules/tsx/dist/loader.mjs'), join(root, 'packages/mcp/src/stdio.ts')], {
      cwd: root, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    server.stderr!.on('data', data => { stderr += data })
    const exited = once(server, 'exit')
    const pending = new Map<number, (message: any) => void>()
    let id = 0
    const lines = createInterface({ input: server.stdout! })
    lines.on('line', line => {
      const message = JSON.parse(line)
      pending.get(message.id)?.(message)
      pending.delete(message.id)
    })
    const request = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
      const callId = ++id
      const timer = setTimeout(() => { pending.delete(callId); reject(new Error(`No response to ${method}: ${stderr}`)) }, 5000)
      pending.set(callId, message => { clearTimeout(timer); resolve(message) })
      server!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: callId, method, params }) + '\n')
    })
    const tool = async (name: string, args: unknown) => (await request('tools/call', { name, arguments: args })).result.structuredContent
    await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'eof-regression', version: '1' } })
    server.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    const proposed = await tool('propose_change', { instance: 'sample', baseRevision: 2, changes: [{ kind: 'add_field', entity: 'jobs', field: 'notes', definition: { type: 'text' } }] })
    expect(proposed.ok).toBe(true)
    expect((await tool('validate', { proposalId: proposed.proposalId })).ok).toBe(true)
    // Leave this request active; EOF must cancel it without an SDK client sending a signal.
    server.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: 'apply_to_disposable', arguments: { proposalId: proposed.proposalId } } }) + '\n')
    await waitFor(async () => {
      try { children = JSON.parse(await readFile(marker, 'utf8')); return true } catch { return false }
    }, 5000)
    expect(await readdir(join(dir, 'proposals'))).toContain('.lock')
    const start = Date.now()
    server.stdin!.end()
    await waitFor(() => server!.exitCode !== null || server!.signalCode !== null)
    expect(await exited).toEqual([0, null])
    await waitFor(() => !alive(children!.pid) && !alive(children!.descendant), Math.max(1, 2000 - (Date.now() - start)))
    expect(Date.now() - start).toBeLessThan(2000)
    expect(alive(server.pid!)).toBe(false)
    expect(await readFile(terminated, 'utf8')).toBe('SIGTERM')
    expect(await readdir(join(dir, 'proposals'))).not.toContain('.lock')
    expect(JSON.parse(await readFile(join(dir, 'proposals', `${proposed.proposalId}.json`), 'utf8'))).toMatchObject({ status: 'validated' })
    expect((await readdir(stateRoot)).sort()).toEqual(stateBefore)
  } finally {
    if (!children) { try { children = JSON.parse(await readFile(marker, 'utf8')) } catch { /* no child started */ } }
    if (children) { try { process.kill(-children.pid, 'SIGKILL') } catch { /* already stopped */ } }
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit')
      process.kill(-server.pid!, 'SIGKILL')
      await exited
    }
    cleanupTempDir(root)
  }
})
