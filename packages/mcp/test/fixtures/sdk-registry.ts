import { registerTempDir, cleanupTempDir } from '../../../../scripts/lib/test-temp-dir.mjs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A closed registry and byte-identical installed tree; no package-manager/network dependency. */
export async function registryFixture() {
  const base = registerTempDir(await mkdtemp(join(tmpdir(), 'sdk-registry-')))
  const root = join(base, 'consumer'), archives = join(base, 'archives'), version = '0.2.9'
  const names = ['core', 'plugins', 'mcp'].map(name => `@workbasehq/${name}`)
  const payloads = new Map<string, Buffer>()
  let mode = '', registry = ''
  const packages: { name: string; version: string; integrity: string; tarball: string }[] = []
  const server = createServer((req, res) => {
    const path = decodeURIComponent(req.url!).slice(1)
    if (mode === 'slow') { res.writeHead(200); res.write('{'); return }
    if (path.startsWith('archives/')) { res.end(payloads.get(path.slice(9))); return }
    const pkg = packages.find(pkg => path === `${pkg.name}/${version}`)
    if (!pkg || mode === 'missing') { res.writeHead(404); res.end('{}'); return }
    res.end(JSON.stringify({ name: pkg.name, version: mode === 'version' ? '0.2.8' : version,
      dist: { tarball: pkg.tarball, integrity: mode === 'integrity' ? 'sha512-YQ==' : pkg.integrity } }))
  })
  const close = async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    cleanupTempDir(base)
  }
  try {
    await mkdir(archives)
    const pins = Object.fromEntries(names.map(name => [name, version]))
    await mkdir(root)
    await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: pins, overrides: pins }))
    for (const name of names) {
      const short = name.split('/')[1], source = join(base, short), pkg = join(source, 'package')
      await mkdir(pkg, { recursive: true })
      await writeFile(join(pkg, 'package.json'), JSON.stringify({ name, version, bin: './binary.dat' }) + '\n')
      await writeFile(join(pkg, 'binary.dat'), Buffer.from([0xff, 0xfe, 0, 1]))
      const archive = join(archives, `${short}.tgz`)
      execFileSync('tar', ['-czf', archive, 'package'], { cwd: source })
      const bytes = await readFile(archive)
      payloads.set(`${short}.tgz`, bytes)
      packages.push({ name, version, integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'), tarball: '' })
      await cp(pkg, join(root, 'node_modules', name), { recursive: true })
    }
    await writeFile(join(root, 'bun.lock'), JSON.stringify({ lockfileVersion: 1, workspaces: { '': { dependencies: pins } }, overrides: pins,
      packages: Object.fromEntries(packages.map(pkg => [pkg.name, [`${pkg.name}@${version}`, '', { bin: './binary.dat' }, pkg.integrity]])) }))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    registry = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    for (const pkg of packages) pkg.tarball = `${registry}/archives/${pkg.name.split('/')[1]}.tgz`
    return { base, root, archives, version, registry, packages, close, mode: (value: string) => { mode = value },
      substitute: async () => {
        const source = join(base, 'core')
        await writeFile(join(source, 'package/binary.dat'), 'substituted')
        execFileSync('tar', ['-czf', join(archives, 'core.tgz'), 'package'], { cwd: source })
        await writeFile(join(root, 'node_modules/@workbasehq/core/binary.dat'), 'substituted')
      } }
  } catch (error) { server.closeAllConnections(); server.close(); cleanupTempDir(base); throw error }
}
