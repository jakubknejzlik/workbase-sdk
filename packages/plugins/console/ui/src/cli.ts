import { validateInstance } from './validate'
const findings = await validateInstance(process.argv[2] ?? 'packages/plugins/console/ui/fixture')
for (const f of findings) console.error(`${f.file}:${f.line}:${f.col}: ${f.code}${f.lang ? ' [' + f.lang + ']' : ''} ${f.key ?? ''} ${f.message ?? ''}`)
process.exitCode = findings.length ? 1 : 0
