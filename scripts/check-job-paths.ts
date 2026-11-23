import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function assertNoJobPaths(root: string) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
  const jobPath = /codex-scratch[/\\]|wr-[0-9a-f]{8}/i
  const failures = files.filter(file => jobPath.test(file) || jobPath.test(readFileSync(join(root, file), 'utf8')))
  if (failures.length) throw new Error(`Job-specific paths in tracked files:\n${failures.join('\n')}`)
}
