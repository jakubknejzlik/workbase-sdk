import { runSchemaCli } from '@workbasehq/core/migrations/schema-cli'
import { runAccessCli } from '@workbasehq/core/access/lock/cli'
import { assertCoreEnumLabels } from './check-core-enum-labels'
import { checkSdkBoundary } from './check-sdk-boundary'
import { readFileSync } from 'node:fs'
assertCoreEnumLabels(JSON.parse(readFileSync('packages/core/src/query/enum-labels.json', 'utf8')))
process.exitCode = await runSchemaCli('check', ['--config', 'packages/core/test/fixtures/config-era/config.ts', '--base', `origin/${process.env.GITHUB_BASE_REF || 'main'}`, ...process.argv.slice(2)]) || await runAccessCli(['--config', 'packages/core/test/fixtures/config-era/config.ts',
  '--root', '.', '--directory', 'packages/core/test/fixtures/config-era']) || checkSdkBoundary(process.cwd(), true)
