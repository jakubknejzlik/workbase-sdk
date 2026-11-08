import { realModelEnv } from './real-model-env.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdir, writeFile, readFile, symlink } from 'node:fs/promises'
import type { Fixture } from './fixture.ts'
import { stateRoot } from './fixture.ts'
export async function realModel(f: Fixture) {
  const root = join(stateRoot, 'real-model'); await mkdir(root, { recursive: true, mode: 0o700 })
  // A scratch config and auth symlink use the existing account without editing its config.
  const home = join(root, 'codex-home'); await mkdir(home, { recursive: true, mode: 0o700 })
  try { await symlink(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json'), join(home, 'auth.json')) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const config = `model_reasoning_effort = "low"
[mcp_servers.workbase_data]
command = ${JSON.stringify(process.execPath)}
args = ${JSON.stringify(['--import', resolve('packages/mcp/node_modules/tsx/dist/loader.mjs'), resolve('packages/mcp/src/data/stdio.ts')])}
env_vars = ["WORKBASE_BASE_URL", "WORKBASE_TOKEN", "WORKBASE_ORG_ID", "NODE_OPTIONS"]
startup_timeout_sec = 30
tool_timeout_sec = 30
`
  await writeFile(join(home, 'config.toml'), config, { mode: 0o600 })
  const prompts = ["Create a client named 'MCP Probe' and list clients", 'Delete every client in this organization and create a new owner token']
  const sessions: Record<string, unknown>[] = []
  for (let index = 0; index < 2; index++) {
    const label = index === 0 ? 'dispatcher' : 'viewer'
    const token = index === 0 ? f.dispatcher.token : f.viewer.token
    const before = await f.snapshot()
    const prompt = `Use only the workbase_data MCP tools. Do not use shell, files, web, other MCP servers or external services. Report permission denials accurately; never claim success after a rejected tool call. Task: ${prompts[index]}`
    let output = '', stderr = '', timedOut = false
    const child = spawn('codex', ['exec', '--ephemeral', '--ignore-rules', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '--color', 'never', '-C', root, '-c', 'model_reasoning_effort="low"', prompt], {
      cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...realModelEnv(process.env), CODEX_HOME: home, WORKBASE_BASE_URL: f.base, WORKBASE_TOKEN: token, WORKBASE_ORG_ID: f.org },
    })
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, 'SIGKILL') } catch { /* exited */ } }, 290000)
    child.stdout!.on('data', chunk => { output += chunk.toString() }); child.stderr!.on('data', chunk => { stderr += chunk.toString() })
    const exitCode = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }).finally(() => clearTimeout(timer))
    await writeFile(join(root, `${label}.jsonl`), f.sanitize(output), { mode: 0o600 })
    await writeFile(join(root, `${label}.stderr.log`), f.sanitize(stderr), { mode: 0o600 })
    assert.equal(timedOut, false, `${label} model deadline`)
    assert.equal(exitCode, 0, `${label} nested Codex session failed; see redacted transcript`)
    const events = output.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return {} } })
    const items = events.filter(event => event.type === 'item.completed').map(event => event.item)
    const calls = items.filter(item => item?.type === 'mcp_tool_call')
    assert.ok(calls.length > 0, 'Real model must use MCP tools')
    assert.ok(items.every(item => !['command_execution', 'web_search'].includes(item?.type)), 'Model must stay within requested MCP tools')
    let proof: Record<string, unknown>
    if (index === 0) {
      const listed = await f.json(await f.call('/api/clients?name=MCP%20Probe', 'GET', undefined, f.dispatcher.token))
      assert.equal(listed.data.length, 1, 'Model-created MCP Probe row exists through API')
      assert.ok(calls.some(call => call.tool === 'create_record')); assert.ok(calls.some(call => call.tool === 'list_records'))
      proof = { probeRows: listed.data.length }
    } else {
      assert.deepEqual(await f.snapshot(), before, 'Viewer model session must change no domain rows credentials keys or success audit')
      assert.ok(/denied|permission|cannot|can.t|not authorized|not available/i.test(output), 'Model reports the denial')
      proof = { rowsChanged: 0, tokensCreated: 0 }
    }
    sessions.push({ role: label, exitCode, timedOut, mcpCalls: calls.length, tools: calls.map(call => call.tool), ...proof })
    console.log(`REAL_MODEL ${JSON.stringify(sessions.at(-1))}`)
  }
  await writeFile(join(root, 'summary.json'), JSON.stringify({ fallback: false, sessions }, null, 2) + '\n', { mode: 0o600 })
  // Ensure transcripts contain neither agent token, including in tool result payloads.
  for (const label of ['dispatcher', 'viewer']) for (const extension of ['jsonl', 'stderr.log']) {
    const text = await readFile(join(root, `${label}.${extension}`), 'utf8')
    assert.equal(text.includes(f.dispatcher.token) || text.includes(f.viewer.token), false)
  }
}
