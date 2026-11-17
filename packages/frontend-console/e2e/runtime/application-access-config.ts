import { workerAccessFixture } from '../../../core/test/fixtures/worker-access'
import { consoleUI } from '@workbasehq/plugins/console'
export const applicationAccessConfig = workerAccessFixture()
applicationAccessConfig.interactive = true
applicationAccessConfig.plugins = [...applicationAccessConfig.plugins!, consoleUI()]
// Synthetic Staff can see all three row shapes while access status remains denied.
applicationAccessConfig.effectiveAccess!.entities.find(rule => rule.entity === 'worker' && rule.role === 'staff' && rule.operation === 'read')!.where = {}
