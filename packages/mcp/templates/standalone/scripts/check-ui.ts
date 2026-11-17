import { validateInstance } from '@workbasehq/plugins/console/ui/check'
const findings = await validateInstance(process.cwd())
for (const finding of findings) console.error(`${finding.file}:${finding.line}:${finding.col}: ${finding.code} ${finding.key ?? finding.message ?? ''}`)
if (findings.length) process.exitCode = 1
else console.log('check:ui: sources, layouts, navigation and dictionaries match')
