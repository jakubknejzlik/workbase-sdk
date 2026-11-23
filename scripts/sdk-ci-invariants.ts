import { runSchemaCli } from '@workbasehq/core/migrations/schema-cli'
import { runOpenApiCli } from '@workbasehq/core/openapi/cli'
import { runAccessCli } from '@workbasehq/core/access/lock/cli'
import { assertCoreEnumLabels } from './check-core-enum-labels'
import { checkSdkBoundary } from './check-sdk-boundary'
import { readFileSync } from 'node:fs'
import { schemaBase } from './lib/schema-base'
assertCoreEnumLabels(JSON.parse(readFileSync('packages/core/src/query/enum-labels.json', 'utf8')))
process.exitCode = await runSchemaCli('check', ['--config', 'packages/core/test/fixtures/config-era/config.ts', '--base', schemaBase(), ...process.argv.slice(2)]) || await runAccessCli(['--config', 'packages/core/test/fixtures/config-era/config.ts',
  '--root', '.', '--directory', 'packages/core/test/fixtures/config-era']) || await runOpenApiCli(['--config', 'packages/core/test/fixtures/worker-access/config.ts']) || checkSdkBoundary(process.cwd(), true)
