import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
for (const file of execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)) {
  if (!/\.(ts|tsx|json|mjs|sh|sql|yml|md)$/.test(file)) continue
  const text = readFileSync(file, 'utf8')
  if (/[\t ]+$/m.test(text)) throw new Error('Trailing whitespace: ' + file)
}
console.log('SDK source whitespace lint passed')
