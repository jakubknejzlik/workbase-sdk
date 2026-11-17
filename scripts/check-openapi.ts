import { runOpenApiCli } from '@workbasehq/core/openapi/cli'
process.exitCode = await runOpenApiCli(['--config', 'packages/core/test/fixtures/worker-access/config.ts', ...process.argv.slice(2)])
