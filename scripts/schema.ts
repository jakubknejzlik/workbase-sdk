import { runSchemaCli } from '@workbasehq/core/migrations/schema-cli'
const [command, ...args] = process.argv.slice(2)
if (command !== 'plan' && command !== 'check') throw new Error('Expected plan or check')
process.exitCode = await runSchemaCli(command, ['--config', 'packages/core/test/fixtures/config-era/config.ts', ...args])
