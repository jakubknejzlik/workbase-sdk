import { appendFile, lstat, mkdir, open, readFile, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { constants } from 'node:fs'
import { fail, instanceSelector, schemas, WorkflowError } from './schemas.ts'
import { noLink } from './paths.ts'

export const bootstrapInput = schemas.bootstrap_instance
const outside = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)
}
// Check every component below the trust boundary before creating directories or opening files.
async function safePath(root: string, path: string) {
  if (outside(root, path)) fail('unsafe_path', 'Bootstrap root must be inside the server root', 403)
  await noLink(root, true)
  let current = root
  for (const part of relative(root, path).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part)
    await noLink(current, true)
  }
}
async function templateFiles(dir: string, prefix = ''): Promise<string[]> {
  const paths: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) paths.push(...await templateFiles(join(dir, entry.name), join(prefix, entry.name)))
    else if (entry.isFile()) paths.push(join(prefix, entry.name))
    else fail('unsafe_path', 'Template must contain regular files only', 403)
  }
  return paths.sort()
}
export type BootstrapReport = { ok: true; files: { path: string; status: 'created' | 'unchanged' | 'conflict' }[] }
export async function bootstrapInstance(serverRoot: string, raw: unknown): Promise<BootstrapReport> {
  try { return await bootstrapFiles(serverRoot, raw) }
  catch (error) {
    const io = error as NodeJS.ErrnoException | undefined
    if (!(error instanceof WorkflowError) && typeof io?.code === 'string' && /^E[A-Z0-9]+$/.test(io.code)) {
      const typed = new WorkflowError('io_error', `Filesystem ${io.code} at ${String(io.path ?? serverRoot)}`, 500)
      typed.cause = error
      throw typed
    }
    throw error
  }
}
async function bootstrapFiles(serverRoot: string, raw: unknown): Promise<BootstrapReport> {
  // Reject invalid arguments without creating even an audit file.
  const input = bootstrapInput.parse(raw)
  const selector = instanceSelector(input.id)
  const boundary = resolve(serverRoot)
  const target = resolve(boundary, input.root ?? '.')
  // Existing roots can still have symlinked ancestors. Check all the way to the filesystem root.
  let ancestor = boundary
  while (true) {
    await noLink(ancestor, true)
    const parent = dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  await safePath(boundary, target)
  await safePath(boundary, join(boundary, 'proposals/log.jsonl'))
  const template = fileURLToPath(new URL('../templates/standalone/', import.meta.url).href)
  const { version } = JSON.parse(await readFile(fileURLToPath(new URL('../package.json', import.meta.url).href), 'utf8')) as { version: string }
  const paths = await templateFiles(template)
  // Preflight every destination before the audit or template can write anything.
  for (const path of paths) await safePath(target, join(target, path === 'gitignore' ? '.gitignore' : path))
  await mkdir(join(boundary, 'proposals'), { recursive: true, mode: 0o700 })
  await appendFile(join(boundary, 'proposals/log.jsonl'), JSON.stringify({ timestamp: new Date().toISOString(), callId: crypto.randomUUID(), tool: 'bootstrap_instance' }) + '\n',
    { mode: 0o600, flag: constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW })
  // Audit only validated calls, never caller arguments, IDs or secrets.
  await mkdir(target, { recursive: true })
  const canonicalBoundary = await realpath(boundary)
  const canonicalTarget = await realpath(target)
  if (outside(canonicalBoundary, canonicalTarget)) fail('unsafe_path', 'Bootstrap root escapes the server root', 403)
  const files: BootstrapReport['files'] = []
  for (const source of paths) {
    // npm/Bun pack omit a literal .gitignore; ship its bytes under a data filename.
    const path = source === 'gitignore' ? '.gitignore' : source
    const destination = join(target, path)
    await safePath(target, destination)
    await mkdir(dirname(destination), { recursive: true })
    const content = (await readFile(join(template, source), 'utf8'))
      .replaceAll('{{SDK_VERSION}}', version)
      .replaceAll('{{INSTANCE_ID}}', input.id).replaceAll('{{INSTANCE_SELECTOR}}', selector)
    try {
      const file = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644)
      try { await file.writeFile(content) } finally { await file.close() }
      files.push({ path, status: 'created' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await safePath(target, destination)
      const same = (await lstat(destination)).isFile() && await readFile(destination, 'utf8') === content
      files.push({ path, status: same ? 'unchanged' : 'conflict' })
    }
  }
  return { ok: true, files: files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) }
}
