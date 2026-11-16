import { mkdtemp, readFile, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { createServer } from '../src/server'
import { Workflow } from '../src/workflow'
import { expectedSnapshot } from '../src/offline'
import { prepare } from '../src/planning'
import { applyDisposable } from '../src/disposable'

it('rejects the review3 NULL drift across all workflow boundaries and real Wrangler verification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenizer-drift-'))
  const { server, store } = await createServer({ root }), workflow = new Workflow(store)
  try {
    expect(await workflow.call('bootstrap_instance', { id: 'token_fixture', target: 'cloudflare-github' })).toMatchObject({ ok: true })
    await symlink(resolve('node_modules'), join(root, 'node_modules'))
    const path = join(root, 'schema/worker.ts')
    await writeFile(path, (await readFile(path, 'utf8')).replace('fields: {', "fields: { null: { type: 'bool' },"))
    execFileSync('bun', [resolve('packages/core/src/migrations/schema-cli.ts'), 'plan', '--root', root, '--init'], { encoding: 'utf8' })
    await store.init()
    const clean = await store.load('token-fixture')
    const changes = [{ kind: 'add_field' as const, entity: 'worker', field: 'notes', definition: { type: 'text' as const } }]
    const planned = prepare(clean.config, clean.indexes, changes), expected = await expectedSnapshot(clean, planned)
    const proposal = await workflow.call('propose_change', { instance: 'token-fixture', baseRevision: 1, changes })
    expect(proposal).toMatchObject({ ok: true })
    const domainPath = join(root, 'migrations/0001_r1.sql'), before = await readFile(domainPath, 'utf8')
    const drift = before.replace('CHECK ("null" IN (0,1))', 'CHECK (null IN (0,1))')
    expect(drift).not.toBe(before)
    await writeFile(domainPath, drift)
    const inspect = await workflow.call('inspect_schema', { instance: 'token-fixture' })
    const instance = await workflow.call('validate', { instance: 'token-fixture' })
    const args = { proposalId: proposal.proposalId }
    const validate = await workflow.call('validate', args)
    const preview = await workflow.call('preview_migration', args)
    const disposable = await workflow.call('apply_to_disposable', args)
    // The workflow refuses before launching Wrangler. Exercise persisted D1
    // separately against a snapshot captured from the clean configured schema.
    const persisted = await applyDisposable(await store.load('token-fixture'), planned, expected, false)
    if (process.env.WORKBASE_TOKENIZER_EVIDENCE_ROOT) await writeFile(join(process.env.WORKBASE_TOKENIZER_EVIDENCE_ROOT, 'workflow-results.json'),
      JSON.stringify({ inspect: inspect.validation, instance, validate, preview, disposable, persisted }, null, 2))
    expect.soft(inspect).toMatchObject({ validation: { ok: false, errors: [{ code: 'config_schema_mismatch' }] } })
    for (const result of [instance, validate]) expect.soft(result).toMatchObject({ ok: false, errors: [{ code: 'config_schema_mismatch' }] })
    for (const result of [preview, disposable]) expect.soft(result).toMatchObject({ ok: false, error: { code: 'config_schema_mismatch' } })
    expect.soft(persisted).toMatchObject({ verified: false, diffs: [{ name: 'worker' }] })
  } finally { await server.close(); await rm(root, { recursive: true, force: true }) }
})

it('plans, checks, validates and verifies SDK-generated V3 quoted keyword columns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenizer-keywords-'))
  const { server, store } = await createServer({ root }), workflow = new Workflow(store)
  try {
    expect(await workflow.call('bootstrap_instance', { id: 'token_fixture', target: 'cloudflare-github' })).toMatchObject({ ok: true })
    await symlink(resolve('node_modules'), join(root, 'node_modules'))
    const path = join(root, 'schema/worker.ts')
    const fields = ['check', 'unique', 'constraint', 'primary', 'foreign'].map(name => `${name}: { type: 'text' },`).join(' ')
    await writeFile(path, (await readFile(path, 'utf8')).replace('fields: {', `fields: { ${fields}`))
    const cli = resolve('packages/core/src/migrations/schema-cli.ts')
    execFileSync('bun', [cli, 'plan', '--root', root, '--init'], { encoding: 'utf8' })
    execFileSync('bun', ['run', 'check:schema'], { cwd: root, encoding: 'utf8' })
    const instance = await workflow.call('validate', { instance: 'token-fixture' })
    expect.soft(instance).toMatchObject({ ok: true, errors: [] })
    const proposal = await workflow.call('propose_change', { instance: 'token-fixture', baseRevision: 1,
      changes: [{ kind: 'add_field', entity: 'worker', field: 'notes', definition: { type: 'text' } }] })
    expect(proposal).toMatchObject({ ok: true })
    const args = { proposalId: proposal.proposalId }
    expect.soft(await workflow.call('validate', args)).toMatchObject({ ok: true })
    expect.soft(await workflow.call('preview_migration', args)).toMatchObject({ ok: true })
    const disposable = await workflow.call('apply_to_disposable', args)
    expect.soft(disposable).toMatchObject({ ok: true, verified: true, diffs: [] })
    if (process.env.WORKBASE_TOKENIZER_EVIDENCE_ROOT) await writeFile(join(process.env.WORKBASE_TOKENIZER_EVIDENCE_ROOT, 'keyword-results.json'),
      JSON.stringify({ fields, plan: 'pass', check: 'pass', instance, disposable }, null, 2))
  } finally { await server.close(); await rm(root, { recursive: true, force: true }) }
})
