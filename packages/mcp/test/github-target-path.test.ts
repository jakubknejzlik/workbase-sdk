import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, open, realpath, rename, rm, symlink, writeFile, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadGitHubTarget } from '../src/github-target.ts'

// Intercept the real open, without adding an operator/tool input or racing tasks.
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, open: vi.fn(fs.open) }
})
const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
let root: string
beforeEach(async () => {
  vi.mocked(open).mockReset().mockImplementation(fs.open)
  root = await realpath(await mkdtemp(join(tmpdir(), 'github-target-path-')))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it.each(['ancestor before open', 'leaf after open'])('rejects a changed %s before reading the descriptor', async change => {
  const parent = join(root, 'parent')
  const replacement = join(root, 'replacement')
  const path = join(parent, 'target.json')
  await mkdir(parent)
  await mkdir(replacement)
  // Deliberately invalid JSON markers: reaching the parser would prove a read.
  // There are no token/key files, credentials, network requests or concurrent tasks.
  const marker = 'synthetic-original-file-marker'
  const otherMarker = 'synthetic-replacement-file-marker'
  await writeFile(path, marker)
  await writeFile(join(replacement, 'target.json'), otherMarker)
  let handle: FileHandle | undefined
  let read: ReturnType<typeof vi.spyOn> | undefined
  vi.mocked(open).mockImplementationOnce(async (file, flags, mode) => {
    expect(file).toBe(path)
    if (change === 'ancestor before open') {
      await rename(parent, join(root, 'saved-parent'))
      await symlink(replacement, parent)
    }
    handle = await fs.open(file, flags, mode)
    read = vi.spyOn(handle, 'readFile')
    if (change === 'leaf after open') {
      await rename(path, join(parent, 'saved-target.json'))
      await writeFile(path, otherMarker)
    }
    return handle
  })
  const error = await loadGitHubTarget(path, () => true).catch(error => error)
  expect(open).toHaveBeenCalledOnce()
  expect(error).toMatchObject({ code: 'unsafe_github_path' })
  expect(String(error)).not.toContain(root)
  expect(String(error)).not.toContain(marker)
  expect(String(error)).not.toContain(otherMarker)
  expect(read).not.toHaveBeenCalled()
  expect(handle?.fd).toBe(-1)
})
