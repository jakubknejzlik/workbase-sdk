import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sdkWorkspaceDirectories } from './sdk-workspaces'

test('logs absent private groups, enumerates all groups when present, and keeps filesystem errors strict', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdk-workspaces-'))
  const messages: string[] = []
  const log = console.log
  console.log = message => { messages.push(message) }
  try {
    assert.throws(() => sdkWorkspaceDirectories(root), { code: 'ENOENT' })
    mkdirSync(join(root, 'packages/core'), { recursive: true })
    assert.deepEqual(sdkWorkspaceDirectories(root), [join(root, 'packages/core')])
    assert.deepEqual(messages, ['examples', 'instances', 'apps'].map(group => `SDK workspaces: skipping absent private group ${group}/`))
    for (const group of ['examples', 'instances', 'apps']) mkdirSync(join(root, group, 'private'), { recursive: true })
    messages.length = 0
    assert.deepEqual(sdkWorkspaceDirectories(root), ['packages/core', 'examples/private', 'instances/private', 'apps/private'].map(path => join(root, path)))
    assert.deepEqual(messages, [])
    rmSync(join(root, 'apps'), { recursive: true })
    writeFileSync(join(root, 'apps'), 'invalid directory')
    assert.throws(() => sdkWorkspaceDirectories(root), { code: 'ENOTDIR' })
  } finally {
    console.log = log
    rmSync(root, { recursive: true, force: true })
  }
})
