import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { assertBytes, scanArchives, scanGitleaks, withPolicyDataReviews, type ScanPolicy } from './lib/sdk-export-scan'

const root = process.cwd()
const policy: ScanPolicy = JSON.parse(readFileSync(resolve(root, 'scripts/sdk-scan-policy.json'), 'utf8'))
const reviewed = withPolicyDataReviews(policy)
const files = execFileSync('git', ['--no-replace-objects', 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
for (const path of files) assertBytes(path, readFileSync(resolve(root, path)), reviewed)
scanGitleaks(root, true)
scanArchives(resolve(root, 'dist-sdk'), policy)
console.log(`Public export-tree scans passed: ${files.length} tracked files; customer terms, emails, IDs, hosts, encoded assets and gitleaks; exactly 3 tarballs`)
