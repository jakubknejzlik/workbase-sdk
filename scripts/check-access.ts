import { runAccessCli } from '@workbasehq/core/access/lock/cli'
const fixtureResult = await runAccessCli(['--config', 'packages/core/test/fixtures/config-era/config.ts',
  '--root', '.', '--directory', 'packages/core/test/fixtures/config-era', ...process.argv.slice(2)])

const actionResult = await runAccessCli(['--config', 'packages/core/test/fixtures/record-actions.ts',
  '--root', '.', '--directory', 'packages/core/test/fixtures/record-actions', ...process.argv.slice(2)])
const workerResult = await runAccessCli(['--config', 'packages/core/test/fixtures/worker-access.ts',
  '--root', '.', '--directory', 'packages/core/test/fixtures/worker-access', ...process.argv.slice(2)])
process.exitCode = fixtureResult || actionResult || workerResult
