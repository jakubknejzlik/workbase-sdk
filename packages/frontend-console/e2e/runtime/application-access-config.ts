import { workerAccessFixture } from '../../../core/test/fixtures/worker-access'
import { consoleUI } from '@workbasehq/plugins/console'
export const applicationAccessConfig = workerAccessFixture()
applicationAccessConfig.interactive = true
applicationAccessConfig.plugins = [...applicationAccessConfig.plugins!, consoleUI()]
