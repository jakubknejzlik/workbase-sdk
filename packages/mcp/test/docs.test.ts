import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { schemas } from '../src/schemas.ts'
import { Workflow } from '../src/workflow.ts'
import { Store } from '../src/storage.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mcp-docs-')); roots.push(root)
  await mkdir(join(root, 'docs'))
  for (const name of ['getting-started.md', 'mcp-composition.md', 'migration-0.4.0.md', 'onboarding.md']) {
    await writeFile(join(root, 'docs', name), await readFile(resolve('docs/sdk', name)))
  }
  const { PackagedDocs } = await import('../src/docs.ts')
  return { root, docs: new PackagedDocs(pathToFileURL(root + '/')) }
}
it('registers strict read-only docs inputs and capabilities instance input', () => {
  expect(schemas).toHaveProperty('list_docs')
  expect(schemas).toHaveProperty('read_doc')
  expect(schemas).toHaveProperty('capabilities')
})
it('lists only packaged names with titles and SHA256 over original bytes', async () => {
  const { root, docs } = await fixture()
  await writeFile(join(root, 'docs', 'private.md'), '# Not published')
  const result = await docs.list()
  expect(result.docs).toHaveLength(4)
  for (const doc of result.docs) {
    const bytes = await readFile(join(root, 'docs', doc.name))
    expect(doc.title.length).toBeGreaterThan(0)
    expect(doc.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(await docs.read(doc.name)).toMatchObject({ ok: true, ...doc, content: bytes.toString('utf8') })
  }
})
it('hashes raw UTF8 and CRLF bytes rather than normalized text', async () => {
  const { root, docs } = await fixture()
  const bytes = Buffer.from('# Example ž\r\n\r\nhello\r\n')
  await writeFile(join(root, 'docs/getting-started.md'), bytes)
  expect(await docs.read('getting-started.md')).toMatchObject({ title: 'Example ž', sha256: createHash('sha256').update(bytes).digest('hex'), content: bytes.toString() })
})
it.each(['file', 'directory'])('rejects a %s symlink escaping the packaged docs root', async mode => {
  const { root, docs } = await fixture()
  const outside = await mkdtemp(join(tmpdir(), 'mcp-docs-outside-')); roots.push(outside)
  const marker = '# Synthetic outside marker\nAlex Example\nalex@example.test\n'
  await writeFile(join(outside, 'getting-started.md'), marker)
  if (mode === 'file') {
    await rm(join(root, 'docs/getting-started.md'))
    await symlink(join(outside, 'getting-started.md'), join(root, 'docs/getting-started.md'))
  } else {
    await rm(join(root, 'docs'), { recursive: true })
    await symlink(outside, join(root, 'docs'))
  }
  await expect(docs.read('getting-started.md')).rejects.toBeDefined()
  await expect(docs.list()).rejects.toBeDefined()
})
it('reads normal packaged bytes with an identical hash after rejecting an escape', async () => {
  const { root, docs } = await fixture()
  const path = join(root, 'docs/getting-started.md')
  const bytes = Buffer.from('# Synthetic packaged marker ž\r\nAlex Example\r\n')
  await writeFile(path, bytes)
  const expected = { ok: true, bytes: bytes.length, content: bytes.toString(), sha256: createHash('sha256').update(bytes).digest('hex') }
  expect(await docs.read('getting-started.md')).toMatchObject(expected)
  await rm(path)
  await symlink(join(root, 'docs/onboarding.md'), path)
  await expect(docs.read('getting-started.md')).rejects.toBeDefined()
  await rm(path)
  await writeFile(path, bytes)
  expect(await docs.read('getting-started.md')).toMatchObject(expected)
})
it.each(['../package.json', '/etc/passwd', 'docs/getting-started.md', 'release.md', 'constructor'])('rejects unallowlisted name %s at the tool boundary', async name => {
  const workflow = new Workflow(new Store('/unused', new Set()))
  expect(await workflow.call('read_doc', { name })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
})
it('rejects path and other additional arguments', async () => {
  const workflow = new Workflow(new Store('/unused', new Set()))
  expect(await workflow.call('read_doc', { name: 'getting-started.md', path: '/etc/passwd' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  expect(await workflow.call('list_docs', { instance: 'example' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
})
it('caps document bytes above current docs and rejects oversize on read and list', async () => {
  const { root, docs } = await fixture()
  const { MAX_DOC_BYTES } = await import('../src/docs.ts')
  expect(MAX_DOC_BYTES).toBeGreaterThan(25005)
  expect(MAX_DOC_BYTES).toBeLessThanOrEqual(65536)
  await writeFile(join(root, 'docs/getting-started.md'), Buffer.alloc(MAX_DOC_BYTES, 65))
  expect((await docs.read('getting-started.md')).content.length).toBe(MAX_DOC_BYTES)
  await writeFile(join(root, 'docs/getting-started.md'), Buffer.alloc(MAX_DOC_BYTES + 1, 65))
  await expect(docs.read('getting-started.md')).rejects.toMatchObject({ code: 'doc_too_large' })
  await expect(docs.list()).rejects.toMatchObject({ code: 'doc_too_large' })
})
