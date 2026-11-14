import { afterAll, expect, test } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { applyInstalledConsumerFixture, assertInstalledArtifacts, evidenceDirectory } from '../lib/installed-consumer-live'

const scratch = mkdtempSync(join(tmpdir(), 'workbase-installed-tests-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const put = (path: string, value: unknown) => { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(value)) }

test('fixture anchors match the unchanged template; cs/en and the optional field are confined to the consumer', () => {
  const consumer = join(scratch, 'overlay')
  const template = resolve('packages/mcp/templates/standalone')
  cpSync(template, consumer, { recursive: true })
  const edits = applyInstalledConsumerFixture(consumer)
  for (const path of edits) expect(readFileSync(join(consumer, path))).not.toEqual(readFileSync(join(template, path)))
  expect(readFileSync(join(consumer, 'config.ts'), 'utf8')).toContain("languages: ['cs', 'en']")
  expect(readFileSync(join(consumer, 'schema/worker.ts'), 'utf8')).toContain("note: { type: 'text' }")
  const cs = JSON.parse(readFileSync(join(consumer, 'locales/cs/domain.json'), 'utf8'))
  expect(cs['field.worker.note']).toBe('Poznámka')
  expect(() => applyInstalledConsumerFixture(consumer)).toThrow('Fixture anchor changed')
})

test('evidence path rejects repository, archive and symlink escapes before writing', () => {
  const repository = join(scratch, 'repo'), archives = join(scratch, 'archives')
  mkdirSync(repository); mkdirSync(archives)
  const alias = join(scratch, 'repo-alias'); symlinkSync(repository, alias)
  for (const path of [repository, join(repository, 'screens'), archives, join(alias, 'screens')]) expect(() => evidenceDirectory(path, repository, archives)).toThrow('Evidence must be outside')
  expect(evidenceDirectory(undefined, repository, archives)).toBeUndefined()
  expect(evidenceDirectory(join(scratch, 'evidence/new'), repository, archives)).toBe(join(realpathSync(scratch), 'evidence/new'))
})

function artifacts(name: string) {
  const consumer = join(scratch, name)
  put(join(consumer, 'package-lock.json'), { packages: Object.fromEntries(['core', 'mcp', 'plugins'].map(name => ['node_modules/@workbasehq/' + name, { version: '0.2.15' }])) })
  put(join(consumer, '.mcp.json'), { mcpServers: { workbase_data: { args: ['data'] } } })
  const paths = ['/workers', '/workers/$workerId', '/workers/$workerId/edit', '/workers/new']
  put(join(consumer, '.workbase-ui/manifest.json'), { entities: { worker: { fields: { name: {}, note: {}, user: {} } } }, routes: paths.map(path => ({ path })) })
  writeFileSync(join(consumer, '.workbase-ui/routeTree.gen.ts'), paths.map(path => `fullPath: '${path}'`).join('\n'))
  put(join(consumer, 'schema.lock.json'), { tables: [{ name: 'worker', columns: [...['name', 'note', 'user'].map(name => ({ name })), { name: 'id', implicit: true }] }] })
  put(join(consumer, 'openapi.json'), { components: { schemas: { Row_worker: { properties: { id: {}, ...Object.fromEntries(['name', 'note', 'user'].map(name => [name, { 'x-workbase-field': {} }])) } } } } })
  return consumer
}
for (const mutation of ['extra-package', 'workspace', 'config-server', 'archive', 'routes', 'columns', 'openapi']) {
  test(`negative artifact probe rejects ${mutation}`, () => {
    const consumer = artifacts(mutation)
    expect(() => assertInstalledArtifacts(consumer)).not.toThrow()
    if (mutation === 'extra-package') put(join(consumer, 'package-lock.json'), { packages: { 'node_modules/@workbasehq/ui-v3': {} } })
    if (mutation === 'workspace') put(join(consumer, 'package-lock.json'), { packages: Object.fromEntries(['core', 'mcp', 'plugins'].map(name => ['node_modules/@workbasehq/' + name, { resolved: 'workspace:*' }])) })
    if (mutation === 'config-server') put(join(consumer, '.mcp.json'), { mcpServers: { config: {} } })
    if (mutation === 'archive') mkdirSync(join(consumer, '.workbase/versions'), { recursive: true })
    if (mutation === 'routes') writeFileSync(join(consumer, '.workbase-ui/routeTree.gen.ts'), "fullPath: '/wrong'")
    if (mutation === 'columns') put(join(consumer, 'schema.lock.json'), { tables: [{ name: 'worker', columns: [] }] })
    if (mutation === 'openapi') put(join(consumer, 'openapi.json'), { components: { schemas: { Row_worker: { properties: {} } } } })
    expect(() => assertInstalledArtifacts(consumer)).toThrow()
  })
}

const guard = resolve('scripts/lib/installed-consumer-network.cjs')
test('live guard rejects external IPs, hostnames and omitted hosts across TCP, TLS, fetch and UDP before connecting', () => {
  const probes = [
    "require('node:net').connect(9, '192.0.2.1')",
    "new (require('node:net').Socket)().connect({port:9,host:'localhost'})",
    "require('node:net').connect(9)",
    "require('node:tls').connect({port:443,host:'example.test'})",
    "await fetch('http://example.test')",
    "require('node:dgram').createSocket('udp4').connect(9, '192.0.2.1')",
    "require('node:dgram').createSocket('udp4').send('probe', 9, '192.0.2.1')",
    "require('node:dgram').createSocket('udp4').send(Buffer.from('probe'), 0, 5, 9, '192.0.2.1')",
    "require('node:dgram').createSocket('udp4').send('probe', 9)",
  ]
  for (const probe of probes) {
    const result = spawnSync('node', ['--require', guard, '-e', `(async () => { ${probe} })()`], { encoding: 'utf8', timeout: 5000 })
    expect(result.status, probe).not.toBe(0)
    expect(result.stderr, probe).toContain('Installed consumer permits loopback literals only')
  }
})
test('live guard permits literal loopback TCP/fetch, IPv6 and connected/unconnected UDP', () => {
  const script = `const net=require('node:net'), dgram=require('node:dgram');
const tcp=net.createServer(s=>{s.resume();s.end('HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\nConnection: close\\r\\n\\r\\nok')});
await new Promise(r=>tcp.listen(0,'127.0.0.1',r));
if(await (await fetch('http://127.0.0.1:'+tcp.address().port)).text()!=='ok')throw Error('fetch');
await new Promise(r=>tcp.close(r));
const ipv6=net.createServer(s=>{s.resume();s.end()});await new Promise(r=>ipv6.listen(0,'::1',r));
await new Promise((r,j)=>{const s=net.connect(ipv6.address().port,'::1');s.on('end',r);s.on('error',j);s.resume()});await new Promise(r=>ipv6.close(r));
const udp=dgram.createSocket('udp4');await new Promise(r=>udp.bind(0,'127.0.0.1',r));
const client=dgram.createSocket('udp4');
const received=new Promise(r=>udp.once('message',r));client.send('a',udp.address().port,'127.0.0.1');await received;
await new Promise(r=>client.connect(udp.address().port,'127.0.0.1',r));const again=new Promise(r=>udp.once('message',r));client.send('b');await again;client.close();udp.close();console.log('loopback passed');`
  expect(execFileSync('node', ['--require', guard, '-e', `(async () => { ${script} })()`], { encoding: 'utf8', timeout: 10000 })).toContain('loopback passed')
})
