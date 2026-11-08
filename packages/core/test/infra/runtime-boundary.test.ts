import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { expect, it } from 'vitest'

it('keeps Node/SST tooling and optional deployment peers outside the Worker entry import graph', () => {
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../src')
  const visited = new Set<string>()
  function visit(path: string) {
    if (visited.has(path)) return
    visited.add(path)
    expect(path).not.toContain('/src/infra/')
    if (!/\.tsx?$/.test(path)) return
    for (const imported of ts.preProcessFile(readFileSync(path, 'utf8'), true, true).importedFiles) {
      const name = imported.fileName
      expect(name).not.toMatch(/^(tsx|sst)(\/|$)|^@pulumi\/|^@workbasehq\/core\/infra/)
      // AsyncLocalStorage is an existing Worker nodejs_compat dependency.
      if (name.startsWith('node:')) expect(name).toBe('node:async_hooks')
      if (!name.startsWith('.')) continue
      const target = resolve(dirname(path), name)
      const resolved = [target + '.ts', target + '.tsx', join(target, 'index.ts'), target].find(existsSync)
      expect(resolved, `${path}: ${name}`).toBeDefined()
      visit(resolved!)
    }
  }
  visit(join(sourceRoot, 'index.ts'))
  expect(visited.size).toBeGreaterThan(50)
})
