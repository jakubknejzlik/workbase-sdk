// Run only in a fresh Node process with the operator environment set before import.
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { existsSync } from 'node:fs'
import { mkdir, readdir, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [repo, mode] = process.argv.slice(2)
const launch = process.cwd()
const expectedRoot = resolve(process.env.WORKBASE_MCP_STATE_ROOT ?? '/tmp/codex/mcp-state')
const existedBeforeImport = existsSync(expectedRoot)
const calls = []
const realSpawn = childProcess.spawn
childProcess.spawn = (command, args, options) => {
  calls.push({ config: args[args.indexOf('--config') + 1], persistence: args[args.indexOf('--persist-to') + 1],
    log: options.env.WRANGLER_LOG_PATH, cwd: options.cwd })
  if (mode === 'real') return realSpawn(command, args, options)
  // Path-contract tests inspect the actual disposable subprocess boundary;
  // this stub intentionally fails and does not claim to execute Wrangler.
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
  setImmediate(() => { child.stderr.write('PRIVATE_WRANGLER_OUTPUT'); child.emit('close', 1) })
  return child
}
syncBuiltinESMExports()
const load = path => import(pathToFileURL(join(repo, path)).href)
const { stateRoot, applyDisposable } = await load('packages/mcp/src/disposable.ts')
const existsAfterImport = existsSync(expectedRoot)

if (mode === 'default') {
  console.log(JSON.stringify({ stateRoot, existedBeforeImport, existsAfterImport }))
} else {
  if (mode === 'anchored') {
    await mkdir('other-cwd')
    process.chdir('other-cwd')
  }
  let apply
  if (mode === 'real') {
    const { copyHistoricalInstances } = await load('packages/mcp/test/fixtures.ts')
    const { Store } = await load('packages/mcp/src/storage.ts')
    const { Workflow } = await load('packages/mcp/src/workflow.ts')
    const root = join(launch, 'instance-root')
    await mkdir(root)
    await symlink(join(repo, 'node_modules'), join(root, 'node_modules'))
    await writeFile(join(root, 'package.json'), '{"type":"module"}')
    process.chdir(repo)
    try { await copyHistoricalInstances(root) } finally { process.chdir(launch) }
    const workflow = new Workflow(new Store(root, new Set(['sample'])))
    const proposed = await workflow.call('propose_change', { instance: 'sample', baseRevision: 2,
      changes: [{ kind: 'add_field', entity: 'jobs', field: 'notes', definition: { type: 'text' } }] })
    const validation = await workflow.call('validate', { proposalId: proposed.proposalId })
    if (proposed.ok !== true || validation.ok !== true) throw new Error(JSON.stringify({ proposed, validation }))
    apply = keep => workflow.call('apply_to_disposable', { proposalId: proposed.proposalId, keep })
  } else {
    const { defineInstance } = await load('packages/core/src/config.ts')
    const config = defineInstance({ id: 'path_fixture', revision: 1, roles: ['owner'], entities: {}, permissions: {} })
    const bundle = { config, migrations: [], indexes: [], fingerprint: '', guards: {} }
    apply = keep => applyDisposable(bundle, { target: config, indexes: [], sql: '' }, [], keep)
  }
  const removed = await apply(false)
  const removedExists = calls.length ? existsSync(resolve(calls[0].cwd)) : null
  const kept = await apply(true)
  const keptExists = kept.directory ? existsSync(kept.directory) : false
  const entries = existsSync(expectedRoot) ? await readdir(expectedRoot, { recursive: true }) : []
  console.log(JSON.stringify({ stateRoot, expectedRoot, existedBeforeImport, existsAfterImport, calls,
    removed, removedExists, kept, keptExists, entries }))
}
