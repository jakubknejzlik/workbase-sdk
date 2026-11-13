import { runAccessCli } from '@workbasehq/core/access/lock/cli'
process.exitCode = await runAccessCli(['--config', 'packages/core/test/fixtures/config-era/config.ts',
  '--root', '.', '--directory', 'packages/core/test/fixtures/config-era', ...process.argv.slice(2)])
