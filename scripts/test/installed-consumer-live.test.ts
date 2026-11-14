import { afterAll, expect, test } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import type processes from '../lib/installed-consumer-processes.cjs'
import { applyInstalledConsumerFixture, assertInstalledArtifacts, evidenceDirectory } from '../lib/installed-consumer-live'

const scratch = mkdtempSync(join(tmpdir(), 'workbase-installed-tests-'))
// Keep Unix socket paths below the OS length limit even with macOS's long TMPDIR.
const sockets = mkdtempSync('/tmp/wb-sockets-')
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(sockets, { recursive: true, force: true }) })
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
for (const synchronous of [false, true]) {
  test(`${synchronous ? 'sync' : 'async'} group cleanup checks leader identity and retains leaderless groups`, async () => {
    const table = new Map([[101, 'original 101'], [102, 'original 102'], [103, 'original 103']])
    let registry = ''
    const delivered: [number, string | number][] = []
    const loaded = { exports: {} as typeof processes }
    runInNewContext(readFileSync(resolve('scripts/lib/installed-consumer-processes.cjs'), 'utf8'), {
      module: loaded, setTimeout, Atomics, SharedArrayBuffer, Int32Array,
      process: { env: {}, platform: process.platform, kill: (pid: number, signal: string | number) => { delivered.push([pid, signal]) } },
      require: (name: string) => {
        if (name === 'node:fs') return { appendFileSync: (_file: string, line: string) => { registry += line }, readFileSync: () => registry }
        if (name === 'node:child_process') return {
          ChildProcess: class {},
          execFileSync: (_command: string, args: string[]) => table.get(Number(args.at(-1))) ?? '',
        }
        throw Error('Unexpected dependency: ' + name)
      },
    })
    for (const pid of table.keys()) loaded.exports.register('groups', pid)
    expect(registry).toBe('101\toriginal 101\n102\toriginal 102\n103\toriginal 103\n')
    table.set(102, 'replacement 102')
    table.delete(103)
    const stop = () => synchronous ? loaded.exports.stopGroupsSync('groups', 0, 0) : loaded.exports.stopGroups('groups', 0, 0)
    await stop()
    expect(delivered).toEqual([[-101, 'SIGTERM'], [-103, 'SIGTERM'], [-101, 'SIGKILL'], [-103, 'SIGKILL']])
    // A rejected record stays rejected even if the replacement loses its leader.
    table.delete(102)
    table.set(101, 'replacement 101')
    delivered.length = 0
    await stop()
    expect(delivered).toEqual([[-103, 'SIGTERM'], [-103, 'SIGKILL']])
  })
}

for (const api of ["net.connect", "net.createConnection", "new net.Socket().connect", "tls.connect"]) {
  test(`${api} checks every TCP overload and preserves Unix IPC overloads`, () => {
    const script = `const assert=require('node:assert/strict'), net=require('node:net'), tls=require('node:tls'), dns=require('node:dns');
const connect=(...args)=>${api}(...args);
const lookup=dns.lookup;
dns.lookup=()=>{throw Error('unexpected DNS dispatch')};
for(const host of ['external.example.test','192.0.2.1','localhost']) {
  for(const args of [[{port:443,host}],[{port:'443',host}],[443,host],['443',host],[' 443 ',host],['0x1bb',host]]) {
    assert.throws(()=>connect(...args), /Installed consumer permits loopback literals only/, JSON.stringify(args));
  }
}
for(const args of [[{port:443}],[443],['443']]) assert.throws(()=>connect(...args), /loopback literals only/);
dns.lookup=lookup;
const server=net.createServer(socket=>{socket.on('error',()=>{});socket.resume();socket.end()});
const listen=options=>new Promise((r,j)=>{server.once('error',j);server.listen(options,r)});
const close=()=>new Promise(r=>server.close(r));
const reach=args=>new Promise((r,j)=>{
  const socket=connect(...args);socket.once('error',j);socket.once('connect',()=>{socket.destroy();r()});
});
await listen({port:0,host:'127.0.0.1'});
const port=server.address().port;
for(const args of [[{port,host:'127.0.0.1'}],[{port:String(port),host:'127.0.0.1'}],[port,'127.0.0.1'],[String(port),'127.0.0.1']]) await reach(args);
for(const args of [[{port,host:'127.0.0.1'}],[port,'127.0.0.1'],[String(port),'127.0.0.1']]) await reach([...args,()=>{}]);
await close();
const path=${JSON.stringify(join(sockets, api.replace(/\W/g, '')))};
await listen(path);
await reach([path]);await reach([{path}]);
await reach([path,()=>{}]);await reach([{path},()=>{}]);
await close();
console.log('all overloads passed');`
    const result = spawnSync('node', ['--require', guard, '-e', `(async () => { ${script} })().catch(e=>{console.error(e);process.exit(1)})`], { encoding: 'utf8', timeout: 5000 })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('all overloads passed')
  })
}

for (const mode of ['child', 'no-exit']) {
  test(`live timeout rejects and bounds cleanup when ${mode} ignores termination`, () => {
    const result = spawnSync('node', ['--import', resolve('node_modules/tsx/dist/esm/index.mjs'), resolve('scripts/test/fixtures/installed-consumer-timeout.cjs'), mode], { encoding: 'utf8', timeout: 5000 })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('bounded timeout passed')
  })
}

for (const runtime of ['node', 'bun']) {
  for (const action of ['SIGINT', 'SIGTERM', 'SIGHUP', 'timeout', 'success', 'error', 'exit']) {
    test(`${runtime} live ${action} reaps every group before removing directories`, () => {
      const directory = mkdtempSync(join(scratch, 'lifecycle-'))
      const result = spawnSync('node', [resolve('scripts/test/fixtures/installed-consumer-lifecycle.cjs'), runtime, directory, action, 'tree'], { encoding: 'utf8', timeout: 15000 })
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.stdout).toContain('"survivors":[]')
    }, 20000)
  }
  for (const action of ['SIGINT', 'SIGTERM', 'timeout']) {
    test(`${runtime} live ${action} reaps unresponsive detached Chromium`, () => {
      const directory = mkdtempSync(join(scratch, 'chromium-'))
      const result = spawnSync('node', [resolve('scripts/test/fixtures/installed-consumer-lifecycle.cjs'), runtime, directory, action, 'chromium'], { encoding: 'utf8', timeout: 15000 })
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.stdout).toContain('"survivors":[]')
    }, 20000)
  }
  test(`${runtime} live shutdown reaps groups registered during termination`, () => {
    const directory = mkdtempSync(join(scratch, 'late-'))
    const result = spawnSync('node', [resolve('scripts/test/fixtures/installed-consumer-lifecycle.cjs'), runtime, directory, 'timeout', 'late'], { encoding: 'utf8', timeout: 15000 })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain('"survivors":[]')
  }, 20000)
  for (const kind of ['signal-observer', 'signal-fallback']) {
    test(`${runtime} live cancellation exits with another signal listener (${kind})`, () => {
      const directory = mkdtempSync(join(scratch, 'signal-'))
      const result = spawnSync('node', [resolve('scripts/test/fixtures/installed-consumer-lifecycle.cjs'), runtime, directory, 'SIGTERM', kind], { encoding: 'utf8', timeout: 15000 })
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.stdout).toContain('"survivors":[]')
    }, 20000)
  }
}

test('smoke status qualifies post-install isolation and routed HTTP browser coverage', () => {
  const source = readFileSync(resolve('scripts/smoke-template.ts'), 'utf8')
  const status = source.split('\n').find(line => line.includes('V3 packed template smoke passed:'))!
  expect(status).toContain('steps 1–7 post-install IP network blocked by OS isolation')
  expect(status).toContain('browser origin filter for routed HTTP only (WebSockets not covered)')
})

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
