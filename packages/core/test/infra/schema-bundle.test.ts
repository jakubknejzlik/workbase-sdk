import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { checkBundle, manualEvidence, parseBundle, renderBundle } from '../../src/migrations/schema-bundle'
import { bundleFilename, checkLinkage, plan, type MigrationFiles } from '../../src/migrations/schema-plan'
import { lockBytes, parseLock } from '../../src/migrations/schema-lock'
import { runSchemaCli } from '../../src/migrations/schema-cli'
import { sdkMigrations } from '../../src/migrations/sdk-baseline'
import { renderTable } from '../../src/migrations/schema'
import { sha256 } from '../../src/crypto'
import fixture from '../fixtures/config-era/config'
import { readSchemaBase } from '../../src/migrations/schema-git'
import { schemaBase } from '../../../../scripts/lib/schema-base'

vi.mock('node:child_process', { spy: true })

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const config = (fields: string[] = []) => {
  const next = structuredClone(fixture)
  for (const name of fields) next.entities.worker.fields[name] = { type: 'text', required: false }
  return next
}
async function chain() {
  const r1 = await plan({ config: config(), baseMigrations: {} })
  const files = { [r1.bundle!.filename]: r1.bundle!.sql }
  const r2 = await plan({ baseLock: r1.lock, baseMigrations: files, config: config(['z']) })
  return { r1, r2, files }
}
async function repository() {
  const root = mkdtempSync(join(tmpdir(), 'schema-bundle-')); roots.push(root)
  cpSync(resolve('packages/core/test/fixtures/config-era'), root, { recursive: true })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-q'); git('config', 'user.email', 'synthetic@example.test'); git('config', 'user.name', 'Synthetic')
  const commit = () => { git('add', '.'); git('commit', '-qm', 'fixture'); return git('show', '--no-patch', '--format=%H') }
  const base = commit(), args = ['--root', root, '--base', base]
  const change = (names: string[]) => {
    const file = join(root, 'schema/worker.ts')
    writeFileSync(file, readFileSync(resolve('packages/core/test/fixtures/config-era/schema/worker.ts'), 'utf8').replace('fields: {', `fields: { ${names.map(n => `${n}: { type: 'text', required: false },`).join('')}`))
  }
  return { root, git, commit, base, args, change }
}
const read = (root: string, file: string) => readFileSync(join(root, file), 'utf8')

it.each(['schéma', 'schéma[1]\t\n '])('Git base reads literal Unicode path %j and rejects edited base migrations', async folder => {
  const { root, git, commit } = await repository(), domain = join(root, folder)
  cpSync(resolve('packages/core/test/fixtures/config-era'), domain, { recursive: true })
  git('config', 'core.quotePath', 'true')
  const base = commit(), args = ['--root', root, '--config', `${folder}/config.ts`, '--base', base]
  const state = readSchemaBase(root, base, join(domain, 'schema.lock.json'), join(domain, 'migrations'))
  expect(state.lock).toBe(read(domain, 'schema.lock.json'))
  expect(state.migrations).toEqual({ '0001_r1.sql': read(domain, 'migrations/0001_r1.sql') })
  const file = 'migrations/0001_r1.sql', bundle = parseBundle(file, read(domain, file))
  bundle.pre = 'SELECT 123;\n'; bundle.manual = await manualEvidence(bundle)
  writeFileSync(join(domain, file), renderBundle(bundle))
  expect(await runSchemaCli('check', args)).toBe(1)
  await expect(runSchemaCli('plan', args)).rejects.toThrow('base migration edited')
})
it('Git base fails closed when a listing omits an existing lock', async () => {
  const { root, base } = await repository()
  const listing = vi.mocked(execFileSync).mockReturnValueOnce(base + '\n').mockReturnValueOnce('')
  try {
    expect(() => readSchemaBase(root, base, join(root, 'schema.lock.json'), join(root, 'migrations')))
      .toThrow('Git listing missed existing lock schema.lock.json')
  } finally { listing.mockRestore() }
})
it.each(['inserted', 'reordered'])('linkage rejects %s columns before the base prefix ends', async kind => {
  const { r1, r2, files } = await chain(), lock = parseLock(r2.lock)
  const columns = lock.tables[0].columns
  if (kind === 'inserted') columns.splice(5, 0, columns.pop()!)
  else [columns[5], columns[6]] = [columns[6], columns[5]]
  await expect(checkLinkage(r1.lock, files, lockBytes(lock), { ...files, [r2.bundle!.filename]: r2.bundle!.sql }))
    .rejects.toThrow(/worker\.name:.*column order/)
})
it('planning preserves the base column prefix and appends new columns', async () => {
  const { r1, files } = await chain()
  const next = config(['z', 'a'])
  next.entities.worker.fields = Object.fromEntries(Object.entries(next.entities.worker.fields).reverse())
  const result = await plan({ baseLock: r1.lock, baseMigrations: files, config: next })
  const before = parseLock(r1.lock).tables[0].columns, after = parseLock(result.lock).tables[0].columns
  expect(after.slice(0, before.length)).toEqual(before)
  expect(after.slice(before.length).map(c => c.name)).toEqual(['a', 'z'])
})
it('CI tag and push checks use HEAD after main advances; PR, local and CLI bases remain selectable', async () => {
  const { root, git, args, change, commit } = await repository()
  git('tag', 'sdk-v9.0.0'); change(['merged']); await runSchemaCli('plan', args)
  git('update-ref', 'refs/remotes/origin/main', commit()); git('checkout', '-q', 'sdk-v9.0.0')
  const check = (base: string, override: string[] = []) => runSchemaCli('check', ['--root', root, '--base', base, ...override])
  expect(await check('origin/main')).toBe(1)
  for (const ref of ['refs/tags/sdk-v9.0.0', 'refs/heads/main']) {
    const base = schemaBase({ CI: 'true', GITHUB_REF: ref })
    expect(base).toBe('HEAD'); expect(await check(base)).toBe(0)
    expect(await check(base, ['--base', 'origin/main'])).toBe(1)
  }
  expect(schemaBase({ CI: 'true', GITHUB_BASE_REF: 'stable' })).toBe('origin/stable')
  expect(schemaBase({})).toBe('origin/main')
  expect(await check(schemaBase({}), ['--base', 'HEAD'])).toBe(0)
  const file = 'migrations/0001_r1.sql', bundle = parseBundle(file, read(root, file))
  bundle.pre = 'SELECT 123;\n'; bundle.manual = 'unconfirmed'
  writeFileSync(join(root, file), renderBundle(bundle))
  expect(await check('HEAD')).toBe(1)
})

it('base CLI writes r2, reruns byte-identically and checks ref-tip linkage', async () => {
  const { root, args, change } = await repository(); change(['z'])
  expect(await runSchemaCli('plan', args)).toBe(0)
  const lock = read(root, 'schema.lock.json'), sql = read(root, 'migrations/0002_r2.sql')
  expect(parseLock(lock).revision).toBe(2)
  expect(await runSchemaCli('plan', args)).toBe(0)
  expect(read(root, 'schema.lock.json')).toBe(lock); expect(read(root, 'migrations/0002_r2.sql')).toBe(sql)
  expect(await runSchemaCli('check', args)).toBe(0)
})
it('base CLI rejects missing --base and unresolvable ref', async () => {
  const { root } = await repository()
  await expect(runSchemaCli('plan', ['--root', root])).rejects.toThrow('--base')
  await expect(runSchemaCli('plan', ['--root', root, '--base', 'absent'])).rejects.toThrow('Unresolvable base ref absent')
})
it('base CLI requires init for lockless base and rejects init when base has a lock', async () => {
  const { root, args, commit } = await repository()
  rmSync(join(root, 'schema.lock.json')); rmSync(join(root, 'migrations'), { recursive: true })
  await expect(runSchemaCli('plan', [...args, '--init'])).rejects.toThrow('no lock in base')
  const empty = commit(), fresh = ['--root', root, '--base', empty]
  await expect(runSchemaCli('plan', fresh)).rejects.toThrow('Missing schema.lock.json in base')
  expect(await runSchemaCli('plan', [...fresh, '--init'])).toBe(0)
  expect(await runSchemaCli('check', fresh)).toBe(0)
})
it('linkage accepts identical base bytes and a single valid child', async () => {
  const { r1, r2, files } = await chain()
  await checkLinkage(r1.lock, files, r1.lock, files)
  await checkLinkage(r1.lock, files, r2.lock, { ...files, [r2.bundle!.filename]: r2.bundle!.sql })
})
it.each(['stale base', 'edited base migration', 'two new files', 'N != rN', 'wrong parent', 'revision skip', 'gap', 'header parent', 'generated edit'])('linkage rejects %s', async kind => {
  const { r1, r2, files } = await chain()
  let base = r1.lock, lock = r2.lock
  const migrations: Record<string, string> = { ...files, [r2.bundle!.filename]: r2.bundle!.sql }
  const reasons: Record<string, string> = { 'stale base': 'stale base', 'edited base migration': 'base migration edited', 'two new files': 'exactly one', 'N != rN': 'N must equal rN', 'wrong parent': 'wrong parent', 'revision skip': 'revision skip', gap: 'gap', 'header parent': 'wrong parent', 'generated edit': 'generated region differs' }
  if (kind === 'stale base') base = r1.lock + ' '
  if (kind === 'edited base migration') migrations['0001_r1.sql'] += '-- edit\n'
  if (kind === 'two new files') migrations['0003_r3.sql'] = renderBundle({ ...parseBundle('x', r2.bundle!.sql), revision: 3 })
  if (kind === 'N != rN' || kind === 'gap') { delete migrations['0002_r2.sql']; migrations[kind === 'gap' ? '0003_r3.sql' : '0003_r2.sql'] = kind === 'gap' ? renderBundle({ ...parseBundle('x', r2.bundle!.sql), revision: 3 }) : r2.bundle!.sql }
  if (kind === 'wrong parent') lock = lockBytes({ ...parseLock(lock), parent: 'a'.repeat(64) })
  if (kind === 'revision skip') lock = lockBytes({ ...parseLock(lock), revision: 4 })
  if (kind === 'header parent') migrations['0002_r2.sql'] = r2.bundle!.sql.replace(/parent=[a-f0-9]+/, `parent=${'a'.repeat(64)}`)
  if (kind === 'generated edit') migrations['0002_r2.sql'] = r2.bundle!.sql.replace('ALTER TABLE', '-- edited\nALTER TABLE')
  await expect(checkLinkage(base, files, lock, migrations)).rejects.toThrow(reasons[kind])
})
it.each(['missing header', 'duplicate header', 'missing marker', 'duplicate marker', 'out of order', 'outside before', 'outside between', 'outside after', 'invalid marker'])('parser rejects %s with file:line', async kind => {
  const { r1 } = await chain(); let sql = r1.bundle!.sql
  if (kind === 'missing header') sql = sql.slice(sql.indexOf('\n') + 1)
  if (kind === 'duplicate header') sql = sql.split('\n')[0] + '\n' + sql
  if (kind === 'missing marker') sql = sql.replace('-- workbase:end post-data\n', '')
  if (kind === 'duplicate marker') sql = sql.replace('-- workbase:begin generated', '-- workbase:begin generated\n-- workbase:begin generated')
  if (kind === 'out of order') sql = sql.replace('-- workbase:begin generated', '-- workbase:begin post-data')
  if (kind === 'outside before') sql = 'SELECT 1;\n' + sql
  if (kind === 'outside between') sql = sql.replace('-- workbase:end pre-data\n', '-- workbase:end pre-data\n\n')
  if (kind === 'outside after') sql += 'SELECT 1;\n'
  if (kind === 'invalid marker') sql = sql.replace('-- workbase:begin generated', '-- workbase:begin unknown')
  expect(() => parseBundle('bad.sql', sql)).toThrow(/bad\.sql:\d+:/)
})
it('manual evidence uses UTF-8 length prefixes and distinguishes region boundaries', async () => {
  const bundle = { revision: 1, parent: null, manual: 'none', pre: 'é\n', generated: 'a\n', post: 'bc\n' }
  expect(await manualEvidence(bundle)).toBe(await sha256('3:é\n2:a\n3:bc\n'))
  expect(await manualEvidence(bundle)).not.toBe(await manualEvidence({ ...bundle, generated: 'ab\n', post: 'c\n' }))
})
it('preservation CLI keeps manual bytes, requires confirmation and rejects hand edits', async () => {
  const { root, args, change } = await repository(); change(['z']); await runSchemaCli('plan', args)
  const file = 'migrations/0002_r2.sql', bundle = parseBundle(file, read(root, file))
  bundle.pre = '-- před\r\nSELECT 1;\r\n'; bundle.post = 'SELECT 2;\n'
  writeFileSync(join(root, file), renderBundle(bundle))
  await runSchemaCli('plan', [...args, '--confirm-manual']); expect(await runSchemaCli('check', args)).toBe(0)
  change(['z', 'a']); await runSchemaCli('plan', args)
  const regenerated = parseBundle(file, read(root, file))
  expect(Buffer.from(regenerated.pre)).toEqual(Buffer.from(bundle.pre)); expect(Buffer.from(regenerated.post)).toEqual(Buffer.from(bundle.post))
  expect(regenerated.manual).toBe('unconfirmed'); expect(await runSchemaCli('check', args)).toBe(1)
  await runSchemaCli('plan', [...args, '--confirm-manual']); expect(await runSchemaCli('check', args)).toBe(0)
  const confirmed = read(root, file); await runSchemaCli('plan', args); expect(read(root, file)).toBe(confirmed)
  writeFileSync(join(root, file), confirmed.replace('SELECT 2;', 'SELECT 3;'))
  expect(await runSchemaCli('check', args)).toBe(1)
})
it('renumbering r2 to r3 restores merged file, rewrites parent and requires confirmation', async () => {
  const { root, args, change, commit } = await repository(); change(['z']); await runSchemaCli('plan', args)
  const ownLock = read(root, 'schema.lock.json'), own = parseBundle('own', read(root, 'migrations/0002_r2.sql'))
  own.pre = 'SELECT 1;\r\n'; own.post = '-- keep\n'; own.manual = await manualEvidence(own)
  // Model a moved ref tip with a distinct r2, without checkout in the adapter.
  rmSync(join(root, 'migrations/0002_r2.sql'))
  change(['merged']); await runSchemaCli('plan', args)
  const mergedLock = read(root, 'schema.lock.json'), mergedSQL = read(root, 'migrations/0002_r2.sql'), moved = commit()
  writeFileSync(join(root, 'schema.lock.json'), ownLock); writeFileSync(join(root, 'migrations/0002_r2.sql'), renderBundle(own)); change(['merged', 'z'])
  const movedArgs = ['--root', root, '--base', moved]
  await runSchemaCli('plan', movedArgs)
  const r3 = parseBundle('r3', read(root, 'migrations/0003_r3.sql'))
  expect(r3).toMatchObject({ revision: 3, parent: await sha256(mergedLock), manual: 'unconfirmed', pre: own.pre, post: own.post })
  expect(read(root, 'migrations/0002_r2.sql')).toBe(mergedSQL)
  expect(await runSchemaCli('check', movedArgs)).toBe(1)
  await runSchemaCli('plan', [...movedArgs, '--confirm-manual']); expect(await runSchemaCli('check', movedArgs)).toBe(0)
})
it.each([false, true])('cancellation with manual=%s deletes only empty manual bundles', async manual => {
  const { root, args, change } = await repository(); change(['z']); await runSchemaCli('plan', args)
  const file = 'migrations/0002_r2.sql'
  if (manual) { const b = parseBundle(file, read(root, file)); b.post = 'SELECT 1;\n'; writeFileSync(join(root, file), renderBundle(b)) }
  change([])
  if (manual) { await expect(runSchemaCli('plan', args)).rejects.toThrow('refusing to delete manual'); expect(read(root, file)).toContain('SELECT 1;') }
  else { await runSchemaCli('plan', args); expect(readdirSync(join(root, 'migrations'))).toEqual(['0001_r1.sql']); expect(await runSchemaCli('check', args)).toBe(0) }
})
it('SQLite replay r1+r2+r3 plus SDK baseline equals fresh lock render by PRAGMA introspection', async () => {
  const { r1, r2, files } = await chain()
  const baseFiles: MigrationFiles = { ...files, [r2.bundle!.filename]: r2.bundle!.sql }
  const next = config(['z', 'a']); next.entities.other = structuredClone(next.entities.worker)
  const r3 = await plan({ baseLock: r2.lock, baseMigrations: baseFiles, config: next })
  const replay = new DatabaseSync(':memory:'), fresh = new DatabaseSync(':memory:')
  const introspect = (db: DatabaseSync) => db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => ({
    table: row.name, columns: db.prepare(`PRAGMA table_info(${`"${String(row.name).replaceAll('"', '""')}"`})`).all(),
    fks: db.prepare(`PRAGMA foreign_key_list(${`"${String(row.name).replaceAll('"', '""')}"`})`).all(), indexes: db.prepare(`PRAGMA index_list(${`"${String(row.name).replaceAll('"', '""')}"`})`).all(),
  }))
  try {
    for (const db of [replay, fresh]) { db.exec('PRAGMA foreign_keys=ON'); for (const migration of sdkMigrations()) db.exec(migration.sql) }
    for (const bundle of [r1, r2, r3]) replay.exec(bundle.bundle!.sql)
    for (const table of parseLock(r3.lock).tables) fresh.exec(renderTable(table))
    expect(introspect(replay)).toEqual(introspect(fresh))
  } finally { replay.close(); fresh.close() }
})

it('ledger checksum covers the whole bundle, including manual evidence and bytes', async () => {
  const { readMigrationFiles } = await import('../../src/infra/migration-files')
  const { root, args, change } = await repository()
  change(['z']); await runSchemaCli('plan', args)
  const before = (await readMigrationFiles(join(root, 'migrations')))[1]
  const bundle = parseBundle(before.filename, before.sql); bundle.pre = 'SELECT 1;\n'
  writeFileSync(join(root, 'migrations', before.filename), renderBundle(bundle))
  await runSchemaCli('plan', [...args, '--confirm-manual'])
  const after = (await readMigrationFiles(join(root, 'migrations')))[1]
  expect(after.checksum).toBe(await sha256(after.sql))
  expect(after.checksum).not.toBe(before.checksum)
})
it('planning rejects an edited base file before any writes', async () => {
  const { root, args, change } = await repository(); change(['z'])
  const lock = read(root, 'schema.lock.json'), file = 'migrations/0001_r1.sql'
  writeFileSync(join(root, file), read(root, file) + '-- edited\n')
  await expect(runSchemaCli('plan', args)).rejects.toThrow('base migration edited')
  expect(read(root, 'schema.lock.json')).toBe(lock)
  expect(readdirSync(join(root, 'migrations'))).toEqual(['0001_r1.sql'])
})
it('Git base adapter reads a nested config at an annotated tag without moving refs', async () => {
  const { readSchemaBase } = await import('../../src/migrations/schema-git')
  const { root, git, commit } = await repository()
  cpSync(join(root, 'schema.lock.json'), join(root, 'schema/nested.lock.json'))
  commit(); git('tag', '-am', 'synthetic tag', 'base-tag')
  const refs = git('show-ref')
  const base = readSchemaBase(join(root, 'schema'), 'base-tag', join(root, 'schema/nested.lock.json'), join(root, 'migrations'))
  expect(base.lock).toBe(read(root, 'schema.lock.json'))
  expect(base.migrations['0001_r1.sql']).toBe(read(root, 'migrations/0001_r1.sql'))
  expect(git('show-ref')).toBe(refs)
})
