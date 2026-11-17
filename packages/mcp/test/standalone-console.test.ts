import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { bootstrapInstance } from '../src/bootstrap'
import { publicConsoleResponse, CONSOLE_CSP } from '../../core/src/console'
import type { RuntimeEnv } from '../../core/src/types'

it('builds the generated Instance host and serves its metadata, CSS and deep links through the Worker', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'standalone-console-')))
  const run = (args: string[]) => {
    const result = spawnSync('bun', args, { cwd: root, encoding: 'utf8' })
    expect(result.status, result.stdout + result.stderr).toBe(0)
  }
  try {
    await bootstrapInstance(root, { id: 'console_proof', target: 'cloudflare-github' })
    // Bun isolates workspace tooling; expose the scaffold's declared dependencies.
    const link = (source: string, target: string) => {
      mkdirSync(target, { recursive: true })
      for (const name of readdirSync(source)) {
        const destination = join(target, name)
        if (name.startsWith('@') || name === '.bin') link(join(source, name), destination)
        else if (!existsSync(destination)) symlinkSync(join(source, name), destination)
      }
    }
    for (const directory of ['node_modules', 'packages/mcp/node_modules', 'packages/plugins/node_modules', 'packages/frontend-console/node_modules']) {
      link(resolve(directory), join(root, 'node_modules'))
    }
    run(['run', 'migrate:plan', '--init']); run(['run', 'openapi:write'])
    run(['run', 'typecheck']); run(['run', 'build:console'])
    const output = join(root, 'dist/console'), metadata = JSON.parse(readFileSync(join(output, 'build-meta.json'), 'utf8'))
    const html = readFileSync(join(output, 'index.html'), 'utf8')
    expect(html).toContain('<title>console_proof</title>')
    expect(html).not.toMatch(/<style|style=|<script(?![^>]*src=)/)
    const assets = readdirSync(join(output, 'assets'))
    const code = assets.filter(name => name.endsWith('.js')).map(name => readFileSync(join(output, 'assets', name), 'utf8')).join('\n')
    expect(html).toContain(metadata.sha)
    expect(code).toContain('workbase-build-sha')
    expect(code).toContain('New worker')
    for (const retired of ['/console-info', '/console-model', '/bootstrap', '"/schema"']) expect(code).not.toContain(retired)
    const css = assets.filter(name => name.endsWith('.css')).map(name => readFileSync(join(output, 'assets', name), 'utf8')).join('\n')
    expect(css).toContain('.wb-shell'); expect(css).toContain('500px')
    const env = { SCHEMA_EXPECTED: JSON.stringify({ revision: 1 }), ASSETS: { fetch: async (request: Request) => {
      const path = new URL(request.url).pathname
      try { return new Response(readFileSync(join(output, path)), { headers: { 'Content-Type': path.endsWith('.html') ? 'text/html' : 'application/json' } }) }
      catch { return new Response(null, { status: 404 }) }
    } } } as unknown as RuntimeEnv
    for (const path of ['/workers', '/workers/new', '/workers/record-1', '/workers/record-1/edit', '/sign-in', '/auth/complete']) {
      const response = await publicConsoleResponse(new Request('https://example.test' + path), env)
      expect(response?.status).toBe(200); expect(response?.headers.get('Content-Security-Policy')).toBe(CONSOLE_CSP)
      expect(await response?.text()).toBe(html)
    }
    const response = await publicConsoleResponse(new Request('https://example.test/build.json'), env)
    expect(await response?.json()).toMatchObject({ ...metadata, revision: 1 })
    for (const path of ['/me', '/api/worker', '/schema', '/console-info', '/auth/magic-link']) {
      expect(await publicConsoleResponse(new Request('https://example.test' + path), env)).toBeUndefined()
    }
    // A failed UI check must stop a rebuild; deploy paths cannot silently reuse it.
    writeFileSync(join(root, 'locales/en/ui.json'), '{}\n')
    const failed = spawnSync('bun', ['run', 'build:console'], { cwd: root, encoding: 'utf8' })
    expect(failed.status).not.toBe(0)
    expect(JSON.parse(readFileSync(join(output, 'build-meta.json'), 'utf8'))).toEqual(metadata)
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 120000)
